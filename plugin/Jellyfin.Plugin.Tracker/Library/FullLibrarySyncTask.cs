namespace Jellyfin.Plugin.Tracker.Library;

using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.Tracker.Api;
using Jellyfin.Plugin.Tracker.Configuration;
using Jellyfin.Plugin.Tracker.Events;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

/// <summary>
/// S7.4's snapshot. It exists because deltas are lossy in ways nobody notices:
/// the plugin was down, Jellyfin restarted mid-scan, a handler threw. Do not be
/// tempted to drop it once deltas work -- the failure it covers is silent.
///
/// Unlike deltas this goes straight to the tracker rather than through the
/// outbound queue: a snapshot is only meaningful while its sync is open, and a
/// stale one replayed hours later would reconcile against the wrong library.
/// </summary>
public sealed class FullLibrarySyncTask : IScheduledTask
{
    /// <summary>S7.4 chunks at 500 items.</summary>
    private const int ChunkSize = 500;

    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly TrackerApiClient _client;
    private readonly LibraryExclusion _exclusion;
    private readonly LibraryItemBuilder _builder;
    private readonly Func<PluginConfiguration> _configuration;
    private readonly ILogger<FullLibrarySyncTask> _logger;

    /// <summary>Initializes a new instance of the <see cref="FullLibrarySyncTask"/> class.</summary>
    /// <param name="libraryManager">Jellyfin's library manager.</param>
    /// <param name="userManager">Jellyfin's user manager.</param>
    /// <param name="client">Tracker API client.</param>
    /// <param name="exclusion">Library exclusion check (S15).</param>
    /// <param name="builder">Wire item builder.</param>
    /// <param name="configuration">Reads current plugin configuration.</param>
    /// <param name="logger">Logger.</param>
    public FullLibrarySyncTask(
        ILibraryManager libraryManager,
        IUserManager userManager,
        TrackerApiClient client,
        LibraryExclusion exclusion,
        LibraryItemBuilder builder,
        Func<PluginConfiguration> configuration,
        ILogger<FullLibrarySyncTask> logger)
    {
        _libraryManager = libraryManager;
        _userManager = userManager;
        _client = client;
        _exclusion = exclusion;
        _builder = builder;
        _configuration = configuration;
        _logger = logger;
    }

    /// <inheritdoc />
    public string Name => "Tracker: full library sync";

    /// <inheritdoc />
    public string Key => "TrackerFullLibrarySync";

    /// <inheritdoc />
    public string Description =>
        "Sends a complete inventory to the tracker, repairing anything the incremental updates missed.";

    /// <inheritdoc />
    public string Category => "Tracker";

    /// <inheritdoc />
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() =>
    [
        new TaskTriggerInfo
        {
            Type = TaskTriggerInfo.TriggerDaily,
            TimeOfDayTicks = TimeSpan.FromHours(4).Ticks,
        },
    ];

    /// <inheritdoc />
    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var configuration = _configuration();
        if (!configuration.Enabled || !configuration.IsRegistered)
        {
            _logger.LogInformation("Tracker sync skipped: not enabled or not registered");
            return;
        }

        var items = _libraryManager
            .GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Episode],
                Recursive = true,
                IsVirtualItem = false,
            })
            .Where(_exclusion.IsAllowed)
            .ToList();

        var users = _userManager.Users.ToList();
        if (users.Count == 0 || items.Count == 0)
        {
            progress.Report(100);
            return;
        }

        var done = 0d;
        foreach (var user in users)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await SyncUserAsync(user.Id, items, cancellationToken).ConfigureAwait(false);
            done++;
            progress.Report(done / users.Count * 100);
        }
    }

    private async Task SyncUserAsync(
        Guid userId,
        IReadOnlyList<BaseItem> items,
        CancellationToken cancellationToken)
    {
        var jellyfinUserId = userId.ToString("N");

        var started = await _client.PostForAsync<SyncStartResponse>(
            "api/v1/library/sync/start",
            JsonSerializer.Serialize(new SyncStartRequest
            {
                JellyfinUserId = jellyfinUserId,
                EstimatedCount = items.Count,
            }),
            cancellationToken).ConfigureAwait(false);

        if (started is null)
        {
            // 409 unlinked_account is the ordinary case, not a failure: S7.4
            // sends every local account because it cannot know which are linked.
            _logger.LogDebug("Tracker declined a sync for Jellyfin user {User}", jellyfinUserId);
            return;
        }

        for (var offset = 0; offset < items.Count; offset += ChunkSize)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var chunk = new List<LibraryItemDto>(ChunkSize);
            foreach (var item in items.Skip(offset).Take(ChunkSize))
            {
                if (_builder.Build(item) is { } dto)
                {
                    chunk.Add(dto);
                }
            }

            if (chunk.Count == 0)
            {
                continue;
            }

            var result = await _client.PostAsync(
                "api/v1/library/sync/chunk",
                JsonSerializer.Serialize(new SyncChunkRequest
                {
                    SyncId = started.SyncId,
                    Items = chunk,
                }),
                cancellationToken).ConfigureAwait(false);

            if (!result.Delivered)
            {
                // S6.3.2: a sync that never reaches finish deletes nothing, so
                // abandoning here is safe. The next run starts clean.
                _logger.LogWarning(
                    "Abandoning sync {SyncId}: {Detail}",
                    started.SyncId,
                    result.Detail);
                return;
            }
        }

        var finish = await _client.PostAsync(
            "api/v1/library/sync/finish",
            JsonSerializer.Serialize(new SyncFinishRequest { SyncId = started.SyncId }),
            cancellationToken).ConfigureAwait(false);

        _logger.LogInformation(
            "Tracker sync for {User} finished: {Status}",
            jellyfinUserId,
            finish.Delivered
                ? "ok"
                : string.Create(CultureInfo.InvariantCulture, $"failed ({finish.Detail})"));
    }
}
