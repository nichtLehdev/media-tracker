namespace Jellyfin.Plugin.Tracker.Media;

using Jellyfin.Data.Enums;
using Jellyfin.Plugin.Tracker.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

/// <summary>
/// S7.7. Jellyfin already ran ffprobe at scan time and stored the result, so
/// this reads it rather than recomputing anything.
/// </summary>
public sealed class MediaProfileReader
{
    private readonly IMediaSourceManager _mediaSourceManager;

    /// <summary>Initializes a new instance of the <see cref="MediaProfileReader"/> class.</summary>
    /// <param name="mediaSourceManager">Jellyfin's media source manager.</param>
    public MediaProfileReader(IMediaSourceManager mediaSourceManager) =>
        _mediaSourceManager = mediaSourceManager;

    /// <summary>Reads the stored technical profile for an item.</summary>
    /// <param name="item">Jellyfin item.</param>
    /// <returns>The profile, or null when the item has no usable streams.</returns>
    public MediaProfileDto? Read(BaseItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        var streams = _mediaSourceManager.GetMediaStreams(item.Id);
        if (streams is null || streams.Count == 0)
        {
            return null;
        }

        // S7.7: for a multi-version item report the *best* version by height,
        // since that is what decides whether the group can watch it together.
        MediaStream? video = null;
        foreach (var stream in streams)
        {
            if (stream.Type != MediaStreamType.Video)
            {
                continue;
            }

            if (video is null || (stream.Height ?? 0) > (video.Height ?? 0))
            {
                video = stream;
            }
        }

        var profile = new MediaProfileDto
        {
            Container = item.Container,
            SizeBytes = item.Size,
            RuntimeSec = item.RunTimeTicks is null
                ? null
                : (int)TimeSpan.FromTicks(item.RunTimeTicks.Value).TotalSeconds,
            Video = video is null
                ? null
                : new VideoStreamDto
                {
                    Codec = video.Codec,
                    Width = video.Width,
                    Height = video.Height,
                    Range = MapRange(video.VideoRangeType),
                    Bitrate = video.BitRate,
                },
        };

        foreach (var stream in streams)
        {
            switch (stream.Type)
            {
                case MediaStreamType.Audio:
                    profile.Audio.Add(new AudioStreamDto
                    {
                        Lang = LanguageNormaliser.Normalise(stream.Language),
                        Codec = stream.Codec,
                        Channels = stream.Channels,
                        Default = stream.IsDefault,
                    });
                    break;

                case MediaStreamType.Subtitle:
                    profile.Subtitles.Add(new SubtitleStreamDto
                    {
                        Lang = LanguageNormaliser.Normalise(stream.Language),
                        Codec = stream.Codec,
                        Forced = stream.IsForced,
                        External = stream.IsExternal,
                    });
                    break;

                default:
                    break;
            }
        }

        return profile;
    }

    /// <summary>
    /// Jellyfin's range enum is finer-grained than the tracker's (S5.4 stores
    /// SDR, HDR10, HDR10+, DV or HLG). The Dolby Vision combinations all report
    /// as DV: a player that can handle DV handles them, and the fallback layer
    /// is not what decides whether the group can watch together.
    /// </summary>
    private static string? MapRange(VideoRangeType range) => range switch
    {
        VideoRangeType.SDR => "SDR",
        VideoRangeType.HDR10 => "HDR10",
        VideoRangeType.HDR10Plus => "HDR10+",
        VideoRangeType.HLG => "HLG",
        VideoRangeType.DOVI => "DV",
        VideoRangeType.DOVIWithHDR10 => "DV",
        VideoRangeType.DOVIWithHLG => "DV",
        VideoRangeType.DOVIWithSDR => "DV",
        _ => null,
    };
}
