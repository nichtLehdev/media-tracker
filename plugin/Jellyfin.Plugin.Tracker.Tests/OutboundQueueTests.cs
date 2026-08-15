namespace Jellyfin.Plugin.Tracker.Tests;

using Jellyfin.Plugin.Tracker.Queue;
using Xunit;

/// <summary>
/// S7.3. The queue is the only thing standing between a member's server losing
/// connectivity and their watch history being lost, so the properties tested
/// here are durability, ordering, and never dropping an unacknowledged item.
/// </summary>
public sealed class OutboundQueueTests : IDisposable
{
    private readonly string _directory;
    private readonly string _path;

    public OutboundQueueTests()
    {
        _directory = Path.Combine(Path.GetTempPath(), "tracker-queue-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
        _path = Path.Combine(_directory, "tracker-queue.db");
    }

    private static readonly DateTimeOffset T0 = new(2026, 8, 15, 20, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
            // A pooled handle can outlive the test on Windows; the temp dir is disposable.
        }
    }

    [Fact]
    public void EnqueuedItemsComeBackInOrder()
    {
        using var queue = new OutboundQueue(_path);

        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, """{"n":1}""", T0);
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, """{"n":2}""", T0.AddSeconds(1));
        queue.Enqueue(OutboundQueue.PayloadKind.LibraryDelta, """{"n":3}""", T0.AddSeconds(2));

        var items = queue.Peek(10);

        // Ordering is not cosmetic: a playback stop must not overtake its start.
        Assert.Equal(3, items.Count);
        Assert.Equal("""{"n":1}""", items[0].Payload);
        Assert.Equal("""{"n":3}""", items[2].Payload);
        Assert.Equal(OutboundQueue.PayloadKind.LibraryDelta, items[2].Kind);
    }

    [Fact]
    public void ItemsSurviveTheProcessRestarting()
    {
        using (var queue = new OutboundQueue(_path))
        {
            queue.Enqueue(OutboundQueue.PayloadKind.Ingest, """{"watched":true}""", T0);
        }

        // The whole point of persisting: Jellyfin restarting must not lose it.
        using var reopened = new OutboundQueue(_path);
        var items = reopened.Peek(10);

        Assert.Single(items);
        Assert.Equal("""{"watched":true}""", items[0].Payload);
    }

    [Fact]
    public void PeekDoesNotRemove()
    {
        using var queue = new OutboundQueue(_path);
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, "{}", T0);

        queue.Peek(10);

        // A flush that fails mid-request must leave the item queued.
        Assert.Equal(1, queue.Depth());
    }

    [Fact]
    public void AcknowledgeRemovesOnlyWhatWasAccepted()
    {
        using var queue = new OutboundQueue(_path);
        var first = queue.Enqueue(OutboundQueue.PayloadKind.Ingest, """{"n":1}""", T0);
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, """{"n":2}""", T0);

        var removed = queue.Acknowledge([first]);

        Assert.Equal(1, removed);
        var remaining = queue.Peek(10);
        Assert.Single(remaining);
        Assert.Equal("""{"n":2}""", remaining[0].Payload);
    }

    [Fact]
    public void AcknowledgingNothingIsHarmless()
    {
        using var queue = new OutboundQueue(_path);
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, "{}", T0);

        Assert.Equal(0, queue.Acknowledge([]));
        Assert.Equal(1, queue.Depth());
    }

    [Fact]
    public void PeekIsBounded()
    {
        using var queue = new OutboundQueue(_path);
        for (var i = 0; i < 500; i++)
        {
            queue.Enqueue(OutboundQueue.PayloadKind.Ingest, $$"""{"n":{{i}}}""", T0);
        }

        // S6.2 caps a batch at 200 events; the flush must be able to ask for less
        // than the whole backlog.
        Assert.Equal(200, queue.Peek(200).Count);
    }

    [Fact]
    public void PurgeDropsOnlyItemsPastTheCutoff()
    {
        using var queue = new OutboundQueue(_path);
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, """{"old":true}""", T0.AddDays(-31));
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, """{"old":false}""", T0.AddDays(-29));

        var dropped = queue.Purge(T0.AddDays(-30));

        Assert.Equal(1, dropped);
        var remaining = queue.Peek(10);
        Assert.Single(remaining);
        Assert.Equal("""{"old":false}""", remaining[0].Payload);
    }

    [Fact]
    public void CreatedAtRoundTripsAsUtc()
    {
        using var queue = new OutboundQueue(_path);
        // A plugin in a non-UTC timezone must not shift the queue's own clock,
        // or the 30-day purge drifts by the offset.
        var berlin = new DateTimeOffset(2026, 8, 15, 22, 0, 0, TimeSpan.FromHours(2));
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, "{}", berlin);

        var item = queue.Peek(1)[0];

        Assert.Equal(berlin.ToUniversalTime(), item.CreatedAt);
    }

    [Fact]
    public void ConcurrentWritersDoNotLoseItems()
    {
        using var queue = new OutboundQueue(_path);

        // Jellyfin raises playback and library events on different threads.
        Parallel.For(0, 200, i =>
            queue.Enqueue(OutboundQueue.PayloadKind.Ingest, $$"""{"n":{{i}}}""", T0));

        Assert.Equal(200, queue.Depth());
    }

    [Fact]
    public void DepthReportsQueueSizeForTheConfigPage()
    {
        using var queue = new OutboundQueue(_path);
        Assert.Equal(0, queue.Depth());

        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, "{}", T0);
        queue.Enqueue(OutboundQueue.PayloadKind.Ingest, "{}", T0);

        Assert.Equal(2, queue.Depth());
    }
}
