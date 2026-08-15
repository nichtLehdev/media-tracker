namespace Jellyfin.Plugin.Tracker.Tests;

using Jellyfin.Plugin.Tracker.Library;
using Xunit;

/// <summary>S7.4: flush 60s after the last event, capped at 5 minutes.</summary>
public class DeltaBufferTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 15, 4, 0, 0, TimeSpan.Zero);

    [Fact]
    public void AnEmptyBufferNeverFlushes()
        => Assert.False(new DeltaBuffer<string>().ShouldFlush(T0.AddHours(1)));

    [Fact]
    public void WaitsForQuietBeforeFlushing()
    {
        var buffer = new DeltaBuffer<string>();
        buffer.Add("a", T0);

        Assert.False(buffer.ShouldFlush(T0.AddSeconds(59)));
        Assert.True(buffer.ShouldFlush(T0.AddSeconds(60)));
    }

    [Fact]
    public void EachNewEventRestartsTheQuietWindow()
    {
        var buffer = new DeltaBuffer<string>();
        buffer.Add("a", T0);
        buffer.Add("b", T0.AddSeconds(50));

        Assert.False(buffer.ShouldFlush(T0.AddSeconds(100)));
        Assert.True(buffer.ShouldFlush(T0.AddSeconds(110)));
    }

    [Fact]
    public void FlushesAnywayOnceTheCapIsReached()
    {
        var buffer = new DeltaBuffer<string>();
        buffer.Add("a", T0);

        // A long *arr import keeps the buffer busy; without the cap the tracker
        // would hear nothing until the whole import finished.
        for (var i = 1; i <= 30; i++)
        {
            buffer.Add($"item{i}", T0.AddSeconds(i * 10));
        }

        Assert.True(buffer.ShouldFlush(T0.AddMinutes(5)));
    }

    [Fact]
    public void DrainEmptiesAndReturnsInsertionOrder()
    {
        var buffer = new DeltaBuffer<string>();
        buffer.Add("a", T0);
        buffer.Add("b", T0);

        Assert.Equal(["a", "b"], buffer.Drain());
        Assert.Equal(0, buffer.Count);
        Assert.False(buffer.ShouldFlush(T0.AddHours(1)));
    }

    [Fact]
    public void TheCapMeasuresFromTheFirstItemOfTheCurrentBatch()
    {
        var buffer = new DeltaBuffer<string>();
        buffer.Add("a", T0);
        buffer.Drain();

        // A new batch starts its own clock; it must not inherit the old one and
        // flush immediately.
        buffer.Add("b", T0.AddMinutes(10));
        Assert.False(buffer.ShouldFlush(T0.AddMinutes(10).AddSeconds(30)));
    }

    [Fact]
    public void IsSafeUnderConcurrentWriters()
    {
        var buffer = new DeltaBuffer<int>();
        Parallel.For(0, 500, i => buffer.Add(i, T0));
        Assert.Equal(500, buffer.Count);
    }
}
