namespace Jellyfin.Plugin.Tracker.Api;

using System.Text.Json.Serialization;

/*
 * The wire formats in S6. packages/contracts is the single source of truth for
 * these; the C# side is kept in sync by hand, so every property here names its
 * JSON key explicitly rather than relying on a naming policy.
 */

/// <summary>S6.1 request.</summary>
public sealed class RegisterRequest
{
    /// <summary>The one-time code the owner generated on the website.</summary>
    [JsonPropertyName("registration_code")]
    public string RegistrationCode { get; set; } = string.Empty;

    /// <summary>Owner-chosen display name for this server.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>Jellyfin's version, shown in the owner's server list.</summary>
    [JsonPropertyName("jellyfin_version")]
    public string? JellyfinVersion { get; set; }

    /// <summary>This plugin's version; drives the "outdated" badge (S7.8).</summary>
    [JsonPropertyName("plugin_version")]
    public string? PluginVersion { get; set; }
}

/// <summary>S6.1 response. The secret is returned exactly once.</summary>
public sealed class RegisterResponse
{
    /// <summary>Server id assigned by the tracker.</summary>
    [JsonPropertyName("server_id")]
    public string ServerId { get; set; } = string.Empty;

    /// <summary>Bearer token. Stored in plugin configuration, never logged.</summary>
    [JsonPropertyName("server_secret")]
    public string ServerSecret { get; set; } = string.Empty;
}

/// <summary>Jellyfin's provider id bag, as much of it as S9 resolves against.</summary>
public sealed class ProviderIds
{
    /// <summary>TMDB id.</summary>
    [JsonPropertyName("Tmdb")]
    public string? Tmdb { get; set; }

    /// <summary>IMDB id.</summary>
    [JsonPropertyName("Imdb")]
    public string? Imdb { get; set; }

    /// <summary>TVDB id.</summary>
    [JsonPropertyName("Tvdb")]
    public string? Tvdb { get; set; }
}

/// <summary>S6.2 item. Never carries a path or filename (S15).</summary>
public sealed class IngestItem
{
    /// <summary>Jellyfin's own item id.</summary>
    [JsonPropertyName("jellyfin_item_id")]
    public string JellyfinItemId { get; set; } = string.Empty;

    /// <summary>"Movie" or "Episode".</summary>
    [JsonPropertyName("item_type")]
    public string ItemType { get; set; } = string.Empty;

    /// <summary>Title as Jellyfin has it.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>Production year, when known.</summary>
    [JsonPropertyName("production_year")]
    public int? ProductionYear { get; set; }

    /// <summary>Series name, for episodes.</summary>
    [JsonPropertyName("series_name")]
    public string? SeriesName { get; set; }

    /// <summary>Season number, for episodes.</summary>
    [JsonPropertyName("season")]
    public int? Season { get; set; }

    /// <summary>Episode number, for episodes.</summary>
    [JsonPropertyName("episode")]
    public int? Episode { get; set; }

    /// <summary>Item-level provider ids.</summary>
    [JsonPropertyName("provider_ids")]
    public ProviderIds ProviderIds { get; set; } = new();

    /// <summary>
    /// Series-level provider ids. Episode-level TMDB ids are frequently missing
    /// in real libraries, so S9 resolves the series and matches on numbers.
    /// </summary>
    [JsonPropertyName("series_provider_ids")]
    public ProviderIds SeriesProviderIds { get; set; } = new();
}

/// <summary>S6.2 event.</summary>
public sealed class IngestEvent
{
    /// <summary>Stable per event; the tracker deduplicates on it.</summary>
    [JsonPropertyName("idempotency_key")]
    public string IdempotencyKey { get; set; } = string.Empty;

    /// <summary>Raw Jellyfin user id. Never a tracker identity (C2).</summary>
    [JsonPropertyName("jellyfin_user_id")]
    public string JellyfinUserId { get; set; } = string.Empty;

    /// <summary>One of playback.start, playback.progress, playback.stop, item.played.</summary>
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    /// <summary>When it happened, ISO 8601 with offset.</summary>
    [JsonPropertyName("occurred_at")]
    public string OccurredAt { get; set; } = string.Empty;

    /// <summary>Jellyfin session id, when the event has one.</summary>
    [JsonPropertyName("session_id")]
    public string? SessionId { get; set; }

    /// <summary>The item being played.</summary>
    [JsonPropertyName("item")]
    public IngestItem Item { get; set; } = new();

    /// <summary>Playback position in seconds.</summary>
    [JsonPropertyName("position_sec")]
    public int? PositionSec { get; set; }

    /// <summary>Total runtime in seconds.</summary>
    [JsonPropertyName("runtime_sec")]
    public int? RuntimeSec { get; set; }

    /// <summary>Whether playback is paused.</summary>
    [JsonPropertyName("is_paused")]
    public bool? IsPaused { get; set; }

    /// <summary>Client device name.</summary>
    [JsonPropertyName("device")]
    public string? Device { get; set; }
}

/// <summary>S6.2 request body.</summary>
public sealed class IngestRequest
{
    /// <summary>Up to 200 events.</summary>
    [JsonPropertyName("events")]
    public IList<IngestEvent> Events { get; set; } = [];
}

/// <summary>Per-event outcome (S6.2).</summary>
public sealed class IngestError
{
    /// <summary>Which event this refers to.</summary>
    [JsonPropertyName("idempotency_key")]
    public string IdempotencyKey { get; set; } = string.Empty;

    /// <summary>unlinked_account, unmatched, invalid or internal.</summary>
    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;

    /// <summary>
    /// Whether retrying could ever succeed. The plugin may only drop an event
    /// the tracker accepted, or rejected with this set.
    /// </summary>
    [JsonPropertyName("permanent")]
    public bool Permanent { get; set; }

    /// <summary>Optional detail, for the config page.</summary>
    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

/// <summary>S6.2 response.</summary>
public sealed class IngestResponse
{
    /// <summary>Events applied.</summary>
    [JsonPropertyName("accepted")]
    public int Accepted { get; set; }

    /// <summary>Events refused.</summary>
    [JsonPropertyName("rejected")]
    public int Rejected { get; set; }

    /// <summary>Events whose media could not be resolved (S9).</summary>
    [JsonPropertyName("unmatched")]
    public int Unmatched { get; set; }

    /// <summary>Per-event detail.</summary>
    [JsonPropertyName("errors")]
    public IList<IngestError> Errors { get; set; } = [];
}
