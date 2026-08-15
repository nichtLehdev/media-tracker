namespace Jellyfin.Plugin.Tracker.Library;

using System.Text.Json;
using Jellyfin.Plugin.Tracker.Api;
using Jellyfin.Plugin.Tracker.Configuration;
using Jellyfin.Plugin.Tracker.Events;
using Jellyfin.Plugin.Tracker.Queue;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

/// <summary>
/// S7.4 deltas. Deltas exist for latency; the nightly snapshot exists because
/// deltas are lossy and nobody notices when they go wrong.
///
/// Buffered rather than sent per event, and routed through the same persistent
/// queue as watch events so a delta survives the tracker being unreachable.
/// </summary>
public sealed class LibraryDeltaService : BackgroundService
{
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly OutboundQueue _queue;
    private readonly LibraryExclusion _exclusion;
    private readonly LibraryItemBuilder _builder;
    private readonly Func<PluginConfiguration> _configuration;
    private readonly ILogger<LibraryDeltaService> _logger;

    private readonly DeltaBuffer<BaseItem> _added = new();
    private readonly DeltaBuffer<BaseItem> _updated = new();
    private readonly DeltaBuffer<string> _removed = new();

    /// <summary>Initializes a new instance of the <see cref="LibraryDeltaService"/> class.</summary>
    /// <param name="libraryManager">Jellyfin's library manager.</param>
    /// <param name="userManager">Jellyfin's user manager.</param>
    /// <param name="queue">The durable outbound queue.</param>
    /// <param name="exclusion">Library exclusion check (S15).</param>
    /// <param name="builder">Wire item builder.</param>
    /// <param name="configuration">Reads current plugin configuration.</param>
    /// <param name="logger">Logger.</param>
    public LibraryDeltaService(
        ILibraryManager libraryManager,
        IUserManager userManager,
        OutboundQueue queue,
        LibraryExclusion exclusion,
        LibraryItemBuilder builder,
        Func<PluginConfiguration> configuration,
        ILogger<LibraryDeltaService> logger)
    {
        _libraryManager = libraryManager;
        _userManager = userManager;
        _queue = queue;
        _exclusion = exclusion;
        _builder = builder;
        _configuration = configuration;
        _logger = logger;
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _libraryManager.ItemAdded += OnItemAdded;
        _libraryManager.ItemUpdated += OnItemUpdated;
        _libraryManager.ItemRemoved += OnItemRemoved;

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken).ConfigureAwait(false);

                var now = DateTimeOffset.UtcNow;
                if (_added.ShouldFlush(now) || _updated.ShouldFlush(now) || _removed.ShouldFlush(now))
                {
                    Flush();
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
        finally
        {
            _libraryManager.ItemAdded -= OnItemAdded;
            _libraryManager.ItemUpdated -= OnItemUpdated;
            _libraryManager.ItemRemoved -= OnItemRemoved;
        }
    }

    private void OnItemAdded(object? sender, ItemChangeEventArgs e) => Buffer(_added, e);

    private void OnItemUpdated(object? sender, ItemChangeEventArgs e) => Buffer(_updated, e);

    /// <summary>
    /// S7.4: ItemRemoved gives an id and nothing more that can be trusted --
    /// the item is being torn down and its metadata may already be gone. Send
    /// the id alone. If the library cannot be determined, send it anyway: a
    /// removal leaks nothing, because the tracker either knows that id or
    /// ignores it.
    /// </summary>
    private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
    {
        if (!Enabled() || !ItemMapper.IsTrackable(e.Item) || !_exclusion.IsRemovalAllowed(e.Item))
        {
            return;
        }

        _removed.Add(e.Item.Id.ToString("N"), DateTimeOffset.UtcNow);
    }

    private void Buffer(DeltaBuffer<BaseItem> buffer, ItemChangeEventArgs e)
    {
        if (!Enabled() || !ItemMapper.IsTrackable(e.Item) || !_exclusion.IsAllowed(e.Item))
        {
            return;
        }

        buffer.Add(e.Item, DateTimeOffset.UtcNow);
    }

    private bool Enabled()
    {
        var configuration = _configuration();
        return configuration.Enabled && configuration.IsRegistered;
    }

    private void Flush()
    {
        var added = _added.Drain();
        var updated = _updated.Drain();
        var removed = _removed.Drain();
        if (added.Count == 0 && updated.Count == 0 && removed.Count == 0)
        {
            return;
        }

        // S7.4 runs per local Jellyfin account: the plugin cannot know which
        // are linked, so it sends all of them and the tracker discards the rest.
        foreach (var user in _userManager.Users)
        {
            var request = new LibraryDeltaRequest
            {
                JellyfinUserId = user.Id.ToString("N"),
                Added = Build(added),
                Updated = Build(updated),
                Removed = removed.Select(id => new LibraryRemovalDto { JellyfinItemId = id }).ToList(),
            };

            try
            {
                _queue.Enqueue(
                    OutboundQueue.PayloadKind.LibraryDelta,
                    JsonSerializer.Serialize(request),
                    DateTimeOffset.UtcNow);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Failed to enqueue a library delta");
            }
        }
    }

    private List<LibraryItemDto> Build(IReadOnlyList<BaseItem> items)
    {
        var built = new List<LibraryItemDto>(items.Count);
        foreach (var item in items)
        {
            try
            {
                if (_builder.Build(item) is { } dto)
                {
                    built.Add(dto);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One unreadable item must not lose the rest of the batch.
                _logger.LogWarning(ex, "Skipping an item that could not be mapped");
            }
        }

        return built;
    }
}
