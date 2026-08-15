namespace Jellyfin.Plugin.Tracker.Events;

using System.Collections.Concurrent;

/// <summary>
/// S7.2 throttles PlaybackProgress to one event per 30 seconds per session.
/// Jellyfin raises it every few seconds per active stream; unthrottled, a
/// household watching three things would fill the outbound queue with position
/// updates that the tracker only uses to extend a two-minute TTL (S5.3).
/// </summary>
public sealed class ProgressThrottle
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastSent = new(StringComparer.Ordinal);
    private readonly TimeSpan _interval;

    /// <summary>Initializes a new instance of the <see cref="ProgressThrottle"/> class.</summary>
    /// <param name="interval">Minimum spacing per session. Defaults to 30 seconds.</param>
    public ProgressThrottle(TimeSpan? interval = null) =>
        _interval = interval ?? TimeSpan.FromSeconds(30);

    /// <summary>Decides whether this session's progress event should be sent.</summary>
    /// <param name="sessionId">Jellyfin session id.</param>
    /// <param name="now">Current time.</param>
    /// <returns>True when the event should be enqueued.</returns>
    public bool ShouldSend(string sessionId, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(sessionId);

        var send = false;
        _lastSent.AddOrUpdate(
            sessionId,
            _ =>
            {
                // The first progress event for a session always goes: it is what
                // opens the row if the start event was missed.
                send = true;
                return now;
            },
            (_, previous) =>
            {
                if (now - previous < _interval)
                {
                    return previous;
                }

                send = true;
                return now;
            });

        return send;
    }

    /// <summary>
    /// Forgets a session, on stop. Without this the dictionary grows for the
    /// lifetime of the process on a busy server.
    /// </summary>
    /// <param name="sessionId">Jellyfin session id.</param>
    public void Forget(string sessionId) => _lastSent.TryRemove(sessionId, out _);

    /// <summary>Gets the number of sessions currently tracked.</summary>
    public int TrackedSessions => _lastSent.Count;
}
