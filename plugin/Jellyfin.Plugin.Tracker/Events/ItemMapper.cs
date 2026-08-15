namespace Jellyfin.Plugin.Tracker.Events;

using Jellyfin.Plugin.Tracker.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;

/// <summary>
/// Turns a Jellyfin item into the wire shape (S6.2, S6.3.3). Deliberately
/// carries no path or filename: those leak directory structure and the release
/// group's naming of things a member may not want published (S15).
/// </summary>
public static class ItemMapper
{
    /// <summary>Whether this item is something the tracker cares about.</summary>
    /// <param name="item">Jellyfin item.</param>
    /// <returns>True for movies and episodes.</returns>
    public static bool IsTrackable(BaseItem? item) => item is Movie or Episode;

    /// <summary>Maps a movie or episode to its wire form.</summary>
    /// <param name="item">Jellyfin item.</param>
    /// <returns>The mapped item, or null when the item is not trackable.</returns>
    public static IngestItem? Map(BaseItem? item)
    {
        switch (item)
        {
            case Movie movie:
                return new IngestItem
                {
                    JellyfinItemId = movie.Id.ToString("N"),
                    ItemType = "Movie",
                    Name = movie.Name ?? string.Empty,
                    ProductionYear = movie.ProductionYear,
                    ProviderIds = MapProviderIds(movie.ProviderIds),
                    SeriesProviderIds = new ProviderIds(),
                };

            case Episode episode:
                // S7.2: walk to the series for provider ids. Episode-level TMDB
                // ids are frequently missing in real libraries, and the series id
                // plus season/episode numbers is the reliable path (S9 step 3).
                var series = episode.Series;
                return new IngestItem
                {
                    JellyfinItemId = episode.Id.ToString("N"),
                    ItemType = "Episode",
                    Name = episode.Name ?? string.Empty,
                    ProductionYear = episode.ProductionYear,
                    SeriesName = episode.SeriesName ?? series?.Name,
                    Season = episode.ParentIndexNumber,
                    Episode = episode.IndexNumber,
                    ProviderIds = MapProviderIds(episode.ProviderIds),
                    SeriesProviderIds = MapProviderIds(series?.ProviderIds),
                };

            default:
                return null;
        }
    }

    /// <summary>Converts runtime ticks to whole seconds.</summary>
    /// <param name="ticks">Jellyfin's 100-nanosecond ticks.</param>
    /// <returns>Seconds, or null.</returns>
    public static int? TicksToSeconds(long? ticks) =>
        ticks is null ? null : (int)TimeSpan.FromTicks(ticks.Value).TotalSeconds;

    private static ProviderIds MapProviderIds(IReadOnlyDictionary<string, string>? source)
    {
        var ids = new ProviderIds();
        if (source is null)
        {
            return ids;
        }

        foreach (var (key, value) in source)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (string.Equals(key, "Tmdb", StringComparison.OrdinalIgnoreCase))
            {
                ids.Tmdb = value;
            }
            else if (string.Equals(key, "Imdb", StringComparison.OrdinalIgnoreCase))
            {
                ids.Imdb = value;
            }
            else if (string.Equals(key, "Tvdb", StringComparison.OrdinalIgnoreCase))
            {
                ids.Tvdb = value;
            }
        }

        return ids;
    }
}
