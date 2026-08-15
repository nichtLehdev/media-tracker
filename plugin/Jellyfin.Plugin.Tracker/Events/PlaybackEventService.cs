namespace Jellyfin.Plugin.Tracker.Events;

using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.Tracker.Api;
using Jellyfin.Plugin.Tracker.Configuration;
using Jellyfin.Plugin.Tracker.Queue;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

/// <summary>
/// S7.2. Captures playback and watch events and enqueues them.
///
/// Every handler here returns immediately: the only work done inline is a
/// SQLite append (S7.3). Blocking a Jellyfin event handler on the network
/// would stall playback reporting for every user on the server.
/// </summary>
public sealed class PlaybackEventService : IHostedService
{
    private readonly ISessionManager _sessionManager;
    private readonly IUserDataManager _userDataManager;
    private readonly OutboundQueue _queue;
    private readonly LibraryExclusion _exclusion;
    private readonly ProgressThrottle _throttle = new();
    private readonly ILogger<PlaybackEventService> _logger;
    private readonly Func<PluginConfiguration> _configuration;

    /// <summary>Initializes a new instance of the <see cref="PlaybackEventService"/> class.</summary>
    /// <param name="sessionManager">Jellyfin's session manager.</param>
    /// <param name="userDataManager">Jellyfin's user data manager.</param>
    /// <param name="queue">The durable outbound queue.</param>
    /// <param name="exclusion">Library exclusion check (S15).</param>
    /// <param name="configuration">Reads current plugin configuration.</param>
    /// <param name="logger">Logger.</param>
    public PlaybackEventService(
        ISessionManager sessionManager,
        IUserDataManager userDataManager,
        OutboundQueue queue,
        LibraryExclusion exclusion,
        Func<PluginConfiguration> configuration,
        ILogger<PlaybackEventService> logger)
    {
        _sessionManager = sessionManager;
        _userDataManager = userDataManager;
        _queue = queue;
        _exclusion = exclusion;
        _configuration = configuration;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _sessionManager.PlaybackStart += OnPlaybackStart;
        _sessionManager.PlaybackProgress += OnPlaybackProgress;
        _sessionManager.PlaybackStopped += OnPlaybackStopped;
        _userDataManager.UserDataSaved += OnUserDataSaved;
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _sessionManager.PlaybackStart -= OnPlaybackStart;
        _sessionManager.PlaybackProgress -= OnPlaybackProgress;
        _sessionManager.PlaybackStopped -= OnPlaybackStopped;
        _userDataManager.UserDataSaved -= OnUserDataSaved;
        return Task.CompletedTask;
    }

    private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e)
        => Capture("playback.start", e);

    private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
    {
        var sessionId = e.Session?.Id;
        if (sessionId is not null && !_throttle.ShouldSend(sessionId, DateTimeOffset.UtcNow))
        {
            return;
        }

        Capture("playback.progress", e);
    }

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        Capture("playback.stop", e);
        if (e.Session?.Id is { } sessionId)
        {
            _throttle.Forget(sessionId);
        }
    }

    /// <summary>
    /// S6.2: `item.played` is the only watched signal. Jellyfin has already
    /// applied the member's configured completion threshold before raising
    /// PlaybackFinished, and raises it again on a rewatch -- deriving "watched"
    /// from a stop event and a percentage would disagree with their settings.
    /// </summary>
    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        if (e.SaveReason != UserDataSaveReason.PlaybackFinished)
        {
            return;
        }

        var item = ItemMapper.Map(e.Item);
        if (item is null || !Enabled() || !_exclusion.IsAllowed(e.Item))
        {
            return;
        }

        Enqueue(new IngestEvent
        {
            IdempotencyKey = Guid.NewGuid().ToString("N"),
            JellyfinUserId = e.UserId.ToString("N"),
            Type = "item.played",
            OccurredAt = Now(),
            Item = item,
            // No position: Jellyfin has already applied the member's own
            // completion threshold before raising this, and resets the position
            // on finish. Synthesising 100% would be inventing data.
            RuntimeSec = ItemMapper.TicksToSeconds(e.Item?.RunTimeTicks),
        });
    }

    private void Capture(string type, PlaybackProgressEventArgs e)
    {
        var item = ItemMapper.Map(e.Item);
        if (item is null || !Enabled() || e.Item is null || !_exclusion.IsAllowed(e.Item))
        {
            return;
        }

        // A session can report several users on shared clients; S6.2 maps each
        // one independently, and drops the ones that are not linked.
        foreach (var user in e.Users)
        {
            Enqueue(new IngestEvent
            {
                IdempotencyKey = Guid.NewGuid().ToString("N"),
                JellyfinUserId = user.Id.ToString("N"),
                Type = type,
                OccurredAt = Now(),
                SessionId = e.Session?.Id,
                Item = item,
                PositionSec = ItemMapper.TicksToSeconds(e.PlaybackPositionTicks),
                RuntimeSec = ItemMapper.TicksToSeconds(e.Item.RunTimeTicks),
                IsPaused = e.IsPaused,
                Device = e.Session?.DeviceName,
            });
        }
    }

    private bool Enabled()
    {
        var configuration = _configuration();
        return configuration.Enabled && configuration.IsRegistered;
    }

    private static string Now() =>
        DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);

    private void Enqueue(IngestEvent @event)
    {
        try
        {
            _queue.Enqueue(
                OutboundQueue.PayloadKind.Ingest,
                JsonSerializer.Serialize(@event),
                DateTimeOffset.UtcNow);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A failed enqueue must never propagate into Jellyfin's event
            // pipeline: losing one event is bad, breaking playback is worse.
            _logger.LogError(ex, "Failed to enqueue a {Type} event", @event.Type);
        }
    }
}
