namespace Jellyfin.Plugin.Tracker.Library;

/// <summary>
/// S7.4's debounce, separated from Jellyfin so it can be tested against a
/// clock rather than a library scan: flush 60 seconds after the last event,
/// capped at 5 minutes so a long *arr import reports in slices rather than one
/// giant batch at the end.
/// </summary>
/// <typeparam name="T">Buffered item type.</typeparam>
public sealed class DeltaBuffer<T>
{
    private static readonly TimeSpan Quiet = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan MaxWait = TimeSpan.FromMinutes(5);

    private readonly List<T> _items = [];
    private readonly object _gate = new();
    private DateTimeOffset _firstAt;
    private DateTimeOffset _lastAt;

    /// <summary>Gets the number of buffered items.</summary>
    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _items.Count;
            }
        }
    }

    /// <summary>Buffers an item.</summary>
    /// <param name="item">The item.</param>
    /// <param name="now">Current time.</param>
    public void Add(T item, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_items.Count == 0)
            {
                _firstAt = now;
            }

            _items.Add(item);
            _lastAt = now;
        }
    }

    /// <summary>Whether the buffer is ready to be sent.</summary>
    /// <param name="now">Current time.</param>
    /// <returns>True when quiet long enough, or waiting too long.</returns>
    public bool ShouldFlush(DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_items.Count == 0)
            {
                return false;
            }

            return now - _lastAt >= Quiet || now - _firstAt >= MaxWait;
        }
    }

    /// <summary>Takes everything buffered, leaving it empty.</summary>
    /// <returns>The buffered items.</returns>
    public IReadOnlyList<T> Drain()
    {
        lock (_gate)
        {
            var drained = _items.ToArray();
            _items.Clear();
            return drained;
        }
    }
}
