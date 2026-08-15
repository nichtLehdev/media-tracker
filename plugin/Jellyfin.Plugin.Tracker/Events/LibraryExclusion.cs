namespace Jellyfin.Plugin.Tracker.Events;

using Jellyfin.Plugin.Tracker.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

/// <summary>
/// S15's first enforcement point, and the stronger of the two: an excluded
/// library is never transmitted at all -- not its contents, not its names, not
/// the fact that it exists. This is where private material belongs, because it
/// never leaves the machine.
/// </summary>
public sealed class LibraryExclusion
{
    private readonly ILibraryManager _libraryManager;
    private readonly Func<PluginConfiguration> _configuration;

    /// <summary>Initializes a new instance of the <see cref="LibraryExclusion"/> class.</summary>
    /// <param name="libraryManager">Jellyfin's library manager.</param>
    /// <param name="configuration">Reads current configuration on each check.</param>
    public LibraryExclusion(ILibraryManager libraryManager, Func<PluginConfiguration> configuration)
    {
        _libraryManager = libraryManager;
        _configuration = configuration;
    }

    /// <summary>Whether this item may be reported.</summary>
    /// <param name="item">Jellyfin item.</param>
    /// <returns>True when the item's top-level library is not excluded.</returns>
    public bool IsAllowed(BaseItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        var excluded = _configuration().ExcludedLibraryIds;
        if (excluded.Length == 0)
        {
            return true;
        }

        foreach (var folder in _libraryManager.GetCollectionFolders(item))
        {
            var id = folder.Id.ToString("N");
            foreach (var candidate in excluded)
            {
                if (string.Equals(id, Normalise(candidate), StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// S7.4: at removal time the ancestor chain may already be unresolvable. If
    /// the library cannot be determined, send the removal anyway -- it leaks
    /// nothing, because the tracker either knows that id or ignores it.
    /// </summary>
    /// <param name="item">Jellyfin item, possibly mid-teardown.</param>
    /// <returns>True when the removal may be reported.</returns>
    public bool IsRemovalAllowed(BaseItem? item)
    {
        if (item is null)
        {
            return true;
        }

        try
        {
            return IsAllowed(item);
        }
        catch (InvalidOperationException)
        {
            return true;
        }
    }

    /// <summary>Jellyfin ids appear both dashed and undashed depending on the caller.</summary>
    private static string Normalise(string id) =>
        Guid.TryParse(id, out var parsed) ? parsed.ToString("N") : id;
}
