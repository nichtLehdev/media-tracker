namespace Jellyfin.Plugin.Tracker.Queue;

/// <summary>
/// S7.3's backoff, as a value type so it can be tested without a clock or a
/// network: 15s, 30s, 1m, 5m, 15m, capped.
/// </summary>
public sealed class FlushSchedule
{
    /// <summary>The ladder from S7.3. The first entry is also the idle interval.</summary>
    private static readonly TimeSpan[] Delays =
    [
        TimeSpan.FromSeconds(15),
        TimeSpan.FromSeconds(30),
        TimeSpan.FromMinutes(1),
        TimeSpan.FromMinutes(5),
        TimeSpan.FromMinutes(15),
    ];

    private int _failures;

    /// <summary>Gets the number of consecutive failures.</summary>
    public int Failures => _failures;

    /// <summary>Gets how long to wait before the next attempt.</summary>
    public TimeSpan Delay => Delays[Math.Min(_failures, Delays.Length - 1)];

    /// <summary>Records a successful flush, returning to the idle interval.</summary>
    public void Succeeded() => _failures = 0;

    /// <summary>Records a failure, lengthening the wait up to the cap.</summary>
    public void Failed()
    {
        if (_failures < Delays.Length - 1)
        {
            _failures++;
        }
    }
}
