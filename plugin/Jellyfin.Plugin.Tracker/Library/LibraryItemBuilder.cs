namespace Jellyfin.Plugin.Tracker.Library;

using Jellyfin.Plugin.Tracker.Api;
using Jellyfin.Plugin.Tracker.Configuration;
using Jellyfin.Plugin.Tracker.Events;
using Jellyfin.Plugin.Tracker.Media;
using MediaBrowser.Controller.Entities;

/// <summary>Builds the S6.3.3 wire item, attaching the profile when enabled.</summary>
public sealed class LibraryItemBuilder
{
    private readonly MediaProfileReader _profiles;
    private readonly Func<PluginConfiguration> _configuration;

    /// <summary>Initializes a new instance of the <see cref="LibraryItemBuilder"/> class.</summary>
    /// <param name="profiles">Profile reader (S7.7).</param>
    /// <param name="configuration">Reads current plugin configuration.</param>
    public LibraryItemBuilder(MediaProfileReader profiles, Func<PluginConfiguration> configuration)
    {
        _profiles = profiles;
        _configuration = configuration;
    }

    /// <summary>Maps a Jellyfin item to its library wire form.</summary>
    /// <param name="item">Jellyfin item.</param>
    /// <returns>The item, or null when it is not a movie or episode.</returns>
    public LibraryItemDto? Build(BaseItem item)
    {
        var mapped = ItemMapper.Map(item);
        if (mapped is null)
        {
            return null;
        }

        var dto = new LibraryItemDto
        {
            JellyfinItemId = mapped.JellyfinItemId,
            ItemType = mapped.ItemType,
            Name = mapped.Name,
            ProductionYear = mapped.ProductionYear,
            SeriesName = mapped.SeriesName,
            Season = mapped.Season,
            Episode = mapped.Episode,
            ProviderIds = mapped.ProviderIds,
            SeriesProviderIds = mapped.SeriesProviderIds,
        };

        // S7.7 opt-out: when off, `media` is omitted entirely rather than sent
        // empty, so the tracker can tell "not reported" from "no tracks".
        if (_configuration().ReportMediaProfile)
        {
            dto.Media = _profiles.Read(item);
        }

        return dto;
    }
}
