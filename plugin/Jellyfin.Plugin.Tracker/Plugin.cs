namespace Jellyfin.Plugin.Tracker;

using System.Globalization;
using Jellyfin.Plugin.Tracker.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

/// <summary>S7.1. The plugin entry point.</summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>Initializes a new instance of the <see cref="Plugin"/> class.</summary>
    /// <param name="applicationPaths">Jellyfin's path provider.</param>
    /// <param name="xmlSerializer">Jellyfin's configuration serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        DataPath = applicationPaths.PluginConfigurationsPath;
    }

    /// <summary>
    /// Gets the running instance. Jellyfin constructs plugins itself, so the
    /// hosted services below reach configuration through here.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Tracker";

    /// <inheritdoc />
    public override Guid Id => new("8f1a2c4e-5b3d-4f6a-9c8e-1d2b3a4c5e6f");

    /// <inheritdoc />
    public override string Description =>
        "Reports watch activity and library inventory to a self-hosted media tracker.";

    /// <summary>
    /// Gets the directory for the plugin's own SQLite databases (S7.3, S7.7).
    /// </summary>
    public string DataPath { get; }

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages() =>
    [
        new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = string.Format(
                CultureInfo.InvariantCulture,
                "{0}.Configuration.configPage.html",
                GetType().Namespace),
        },
    ];
}
