namespace Jellyfin.Plugin.Tracker.Queue;

using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.Tracker.Api;
using Jellyfin.Plugin.Tracker.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

/// <summary>
/// S7.3. Drains the outbound queue: every 15 seconds, backing off to 15
/// minutes while the tracker is unreachable, and dropping anything older than
/// 30 days.
/// </summary>
public sealed class QueueFlushService : BackgroundService
{
    /// <summary>S6.2 caps a batch at 200 events.</summary>
    private const int IngestBatchSize = 200;

    /// <summary>S7.3: events older than this are dropped.</summary>
    private static readonly TimeSpan MaxAge = TimeSpan.FromDays(30);

    private readonly OutboundQueue _queue;
    private readonly TrackerApiClient _client;
    private readonly Func<PluginConfiguration> _configuration;
    private readonly ILogger<QueueFlushService> _logger;
    private readonly FlushSchedule _schedule = new();

    /// <summary>Initializes a new instance of the <see cref="QueueFlushService"/> class.</summary>
    /// <param name="queue">The durable queue.</param>
    /// <param name="client">Tracker API client.</param>
    /// <param name="configuration">Reads current plugin configuration.</param>
    /// <param name="logger">Logger.</param>
    public QueueFlushService(
        OutboundQueue queue,
        TrackerApiClient client,
        Func<PluginConfiguration> configuration,
        ILogger<QueueFlushService> logger)
    {
        _queue = queue;
        _client = client;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>Gets the last failure detail, for the config page (S7.5).</summary>
    public string? LastError { get; private set; }

    /// <summary>Gets when the last successful flush completed.</summary>
    public DateTimeOffset? LastSuccessAt { get; private set; }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await FlushOnceAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // The loop must outlive any single failure: if it dies, the
                // queue grows until the disk does.
                _logger.LogError(ex, "Queue flush failed");
                _schedule.Failed();
                LastError = ex.Message;
            }

            try
            {
                await Task.Delay(_schedule.Delay, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task FlushOnceAsync(CancellationToken cancellationToken)
    {
        var configuration = _configuration();
        if (!configuration.Enabled || !configuration.IsRegistered)
        {
            return;
        }

        _queue.Purge(DateTimeOffset.UtcNow - MaxAge);

        var items = _queue.Peek(IngestBatchSize);
        if (items.Count == 0)
        {
            _schedule.Succeeded();
            return;
        }

        // Ingest events batch; library deltas are already whole payloads and go
        // one at a time. Taking the leading run of one kind keeps ordering
        // intact -- a delta must not overtake the events queued before it.
        var kind = items[0].Kind;
        var run = items.TakeWhile(i => i.Kind == kind).ToList();

        var (path, body) = kind switch
        {
            OutboundQueue.PayloadKind.Ingest => ("api/v1/ingest", BatchIngest(run)),
            OutboundQueue.PayloadKind.LibraryDelta => ("api/v1/library/delta", run[0].Payload),
            _ => throw new InvalidOperationException($"unknown payload kind {kind}"),
        };

        // A delta is a whole request, so only ever send one per attempt.
        if (kind == OutboundQueue.PayloadKind.LibraryDelta)
        {
            run = [run[0]];
        }

        var result = await _client.PostAsync(path, body, cancellationToken).ConfigureAwait(false);

        if (result.Delivered)
        {
            _queue.Acknowledge(run.Select(i => i.Id).ToList());
            _schedule.Succeeded();
            LastError = null;
            LastSuccessAt = DateTimeOffset.UtcNow;
            return;
        }

        if (!result.Retryable)
        {
            // The tracker understood and refused. Keeping it would wedge the
            // queue behind a payload that can never be accepted.
            _logger.LogWarning(
                "Dropping {Count} queued item(s) the tracker refused: {Detail}",
                run.Count,
                result.Detail);
            _queue.Acknowledge(run.Select(i => i.Id).ToList());
            LastError = result.Detail;
            _schedule.Succeeded();
            return;
        }

        _schedule.Failed();
        LastError = result.Detail;
    }

    /// <summary>
    /// Assembles one S6.2 request from queued events. They are stored
    /// individually so that a batch which is refused does not take unrelated
    /// events down with it.
    /// </summary>
    private static string BatchIngest(IReadOnlyList<OutboundQueue.QueuedItem> items)
    {
        var builder = new StringBuilder(@"{""events"":[");
        for (var i = 0; i < items.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            builder.Append(items[i].Payload);
        }

        builder.Append("]}");
        var json = builder.ToString();

        // Cheap guard against a malformed payload reaching the wire.
        using var _ = JsonDocument.Parse(json);
        return json;
    }
}
