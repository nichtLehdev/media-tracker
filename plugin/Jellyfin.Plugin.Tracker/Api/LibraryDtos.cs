namespace Jellyfin.Plugin.Tracker.Api;

using System.Text.Json.Serialization;

/// <summary>S6.3.3 video stream.</summary>
public sealed class VideoStreamDto
{
    /// <summary>Codec, e.g. hevc.</summary>
    [JsonPropertyName("codec")]
    public string? Codec { get; set; }

    /// <summary>Pixel width.</summary>
    [JsonPropertyName("width")]
    public int? Width { get; set; }

    /// <summary>Pixel height; this is what decides whether the group can watch it together.</summary>
    [JsonPropertyName("height")]
    public int? Height { get; set; }

    /// <summary>SDR, HDR10, HDR10+, DV or HLG.</summary>
    [JsonPropertyName("range")]
    public string? Range { get; set; }

    /// <summary>Bits per second.</summary>
    [JsonPropertyName("bitrate")]
    public int? Bitrate { get; set; }
}

/// <summary>S6.3.3 audio stream. `lang` is normalised in the plugin (S7.7).</summary>
public sealed class AudioStreamDto
{
    /// <summary>ISO 639-1, or the literal "und".</summary>
    [JsonPropertyName("lang")]
    public string Lang { get; set; } = "und";

    /// <summary>Codec, e.g. truehd.</summary>
    [JsonPropertyName("codec")]
    public string? Codec { get; set; }

    /// <summary>Channel count.</summary>
    [JsonPropertyName("channels")]
    public int? Channels { get; set; }

    /// <summary>Whether this is the default track.</summary>
    [JsonPropertyName("default")]
    public bool? Default { get; set; }
}

/// <summary>S6.3.3 subtitle stream.</summary>
public sealed class SubtitleStreamDto
{
    /// <summary>ISO 639-1, or the literal "und".</summary>
    [JsonPropertyName("lang")]
    public string Lang { get; set; } = "und";

    /// <summary>Codec, e.g. subrip.</summary>
    [JsonPropertyName("codec")]
    public string? Codec { get; set; }

    /// <summary>Whether the track is forced.</summary>
    [JsonPropertyName("forced")]
    public bool? Forced { get; set; }

    /// <summary>Whether the track is a sidecar file.</summary>
    [JsonPropertyName("external")]
    public bool? External { get; set; }
}

/// <summary>S6.3.3 media profile. Omitted entirely when reporting is off (S7.7).</summary>
public sealed class MediaProfileDto
{
    /// <summary>Container, e.g. mkv.</summary>
    [JsonPropertyName("container")]
    public string? Container { get; set; }

    /// <summary>File size in bytes.</summary>
    [JsonPropertyName("size_bytes")]
    public long? SizeBytes { get; set; }

    /// <summary>Runtime in seconds.</summary>
    [JsonPropertyName("runtime_sec")]
    public int? RuntimeSec { get; set; }

    /// <summary>The video track.</summary>
    [JsonPropertyName("video")]
    public VideoStreamDto? Video { get; set; }

    /// <summary>Audio tracks.</summary>
    [JsonPropertyName("audio")]
    public IList<AudioStreamDto> Audio { get; set; } = [];

    /// <summary>Subtitle tracks.</summary>
    [JsonPropertyName("subtitles")]
    public IList<SubtitleStreamDto> Subtitles { get; set; } = [];
}

/// <summary>S6.3.3. An ingest item plus its technical profile.</summary>
public sealed class LibraryItemDto : IngestItem
{
    /// <summary>Omitted when the member has profile reporting off.</summary>
    [JsonPropertyName("media")]
    public MediaProfileDto? Media { get; set; }
}

/// <summary>S6.3.1 removal.</summary>
public sealed class LibraryRemovalDto
{
    /// <summary>All that is available at removal time: the item is already gone.</summary>
    [JsonPropertyName("jellyfin_item_id")]
    public string JellyfinItemId { get; set; } = string.Empty;
}

/// <summary>S6.3.1 request.</summary>
public sealed class LibraryDeltaRequest
{
    /// <summary>Which local Jellyfin account this delta is for.</summary>
    [JsonPropertyName("jellyfin_user_id")]
    public string JellyfinUserId { get; set; } = string.Empty;

    /// <summary>Newly available items.</summary>
    [JsonPropertyName("added")]
    public IList<LibraryItemDto> Added { get; set; } = [];

    /// <summary>Items no longer present.</summary>
    [JsonPropertyName("removed")]
    public IList<LibraryRemovalDto> Removed { get; set; } = [];

    /// <summary>Items replaced in place: same Jellyfin item, new profile.</summary>
    [JsonPropertyName("updated")]
    public IList<LibraryItemDto> Updated { get; set; } = [];
}

/// <summary>S6.3.2 start request.</summary>
public sealed class SyncStartRequest
{
    /// <summary>Which local Jellyfin account this snapshot covers.</summary>
    [JsonPropertyName("jellyfin_user_id")]
    public string JellyfinUserId { get; set; } = string.Empty;

    /// <summary>Rough item count, for the owner's progress display.</summary>
    [JsonPropertyName("estimated_count")]
    public int? EstimatedCount { get; set; }
}

/// <summary>S6.3.2 start response.</summary>
public sealed class SyncStartResponse
{
    /// <summary>Identifies this run on chunk and finish.</summary>
    [JsonPropertyName("sync_id")]
    public string SyncId { get; set; } = string.Empty;
}

/// <summary>S6.3.2 chunk request.</summary>
public sealed class SyncChunkRequest
{
    /// <summary>The run this chunk belongs to.</summary>
    [JsonPropertyName("sync_id")]
    public string SyncId { get; set; } = string.Empty;

    /// <summary>Up to 500 items.</summary>
    [JsonPropertyName("items")]
    public IList<LibraryItemDto> Items { get; set; } = [];
}

/// <summary>S6.3.2 finish request.</summary>
public sealed class SyncFinishRequest
{
    /// <summary>The run to reconcile.</summary>
    [JsonPropertyName("sync_id")]
    public string SyncId { get; set; } = string.Empty;
}
