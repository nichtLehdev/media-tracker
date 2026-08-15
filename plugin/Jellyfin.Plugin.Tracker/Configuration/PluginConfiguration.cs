namespace Jellyfin.Plugin.Tracker.Configuration;

using MediaBrowser.Model.Plugins;

/// <summary>S7.1. Everything the plugin needs to reach one tracker instance.</summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Base URL of the tracker, e.g. https://tracker.lehdev.de.</summary>
    public string TrackerBaseUrl { get; set; } = string.Empty;

    /// <summary>Assigned by the tracker at registration (S6.1).</summary>
    public string ServerId { get; set; } = string.Empty;

    /// <summary>
    /// Bearer token, returned exactly once at registration. Never logged (S15).
    /// </summary>
    public string ServerSecret { get; set; } = string.Empty;

    /// <summary>
    /// Top-level libraries that are never transmitted -- not their contents,
    /// not their names, not the fact that they exist (S15). This is where
    /// private material belongs, because it never leaves the machine.
    /// </summary>
    public string[] ExcludedLibraryIds { get; set; } = [];

    /// <summary>Master switch. When false nothing is captured or sent.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>S7.7 opt-out. When false, `media` is omitted from library items.</summary>
    public bool ReportMediaProfile { get; set; } = true;

    /// <summary>S13.3. Lets the tracker reach this member's Seerr via the command channel.</summary>
    public bool SeerrRelayEnabled { get; set; }

    /// <summary>True once registration has produced credentials.</summary>
    public bool IsRegistered =>
        !string.IsNullOrWhiteSpace(TrackerBaseUrl)
        && !string.IsNullOrWhiteSpace(ServerId)
        && !string.IsNullOrWhiteSpace(ServerSecret);
}
