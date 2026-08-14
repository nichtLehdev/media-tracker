import { describe, expect, it } from 'vitest';
import {
  audioStream,
  langCode,
  mediaProfile,
  subtitleStream,
  videoRange,
  videoStream,
} from './media.js';

describe('videoRange', () => {
  it('accepts the five documented ranges', () => {
    for (const range of ['SDR', 'HDR10', 'HDR10+', 'DV', 'HLG']) {
      expect(videoRange.safeParse(range).success).toBe(true);
    }
  });

  it('rejects an unlisted range', () => {
    expect(videoRange.safeParse('HDR10Plus').success).toBe(false);
  });
});

describe('langCode', () => {
  it('accepts a two-letter ISO 639-1 code', () => {
    expect(langCode.safeParse('en').success).toBe(true);
    expect(langCode.safeParse('de').success).toBe(true);
  });

  it('accepts the literal "und" for unknown language (S7.7)', () => {
    expect(langCode.safeParse('und').success).toBe(true);
  });

  it('rejects a three-letter ISO 639-2 code (normalisation is the plugin\'s job, not the wire format\'s)', () => {
    // S7.7: the plugin normalises "ger"/"deu"/"de-DE"/"German" to "de" before
    // it ever reaches this schema -- the contract only validates the result.
    expect(langCode.safeParse('ger').success).toBe(false);
    expect(langCode.safeParse('deu').success).toBe(false);
  });

  it('rejects a region-tagged code', () => {
    expect(langCode.safeParse('de-DE').success).toBe(false);
  });

  it('rejects uppercase and empty string', () => {
    expect(langCode.safeParse('DE').success).toBe(false);
    expect(langCode.safeParse('').success).toBe(false);
  });
});

describe('audioStream / subtitleStream', () => {
  it('requires lang; codec, channels, and default are optional', () => {
    expect(audioStream.safeParse({ lang: 'en' }).success).toBe(true);
    expect(audioStream.safeParse({}).success).toBe(false);
  });

  it('rejects a zero or negative channel count', () => {
    expect(
      audioStream.safeParse({ lang: 'en', channels: 0 }).success,
    ).toBe(false);
    expect(
      audioStream.safeParse({ lang: 'en', channels: -2 }).success,
    ).toBe(false);
  });

  it('accepts a subtitle stream with forced/external flags', () => {
    const result = subtitleStream.safeParse({
      lang: 'de',
      codec: 'subrip',
      forced: false,
      external: true,
    });
    expect(result.success).toBe(true);
  });

  it('subtitleStream also requires lang', () => {
    expect(subtitleStream.safeParse({ codec: 'subrip' }).success).toBe(
      false,
    );
  });
});

describe('videoStream', () => {
  it('accepts a fully populated stream', () => {
    const result = videoStream.safeParse({
      codec: 'hevc',
      width: 3840,
      height: 2160,
      range: 'HDR10',
      bitrate: 22000000,
    });
    expect(result.success).toBe(true);
  });

  it('every field is optional (a bare {} is a valid, if useless, video stream)', () => {
    expect(videoStream.safeParse({}).success).toBe(true);
  });

  it('rejects a non-positive width or height', () => {
    expect(videoStream.safeParse({ width: 0 }).success).toBe(false);
    expect(videoStream.safeParse({ height: -1 }).success).toBe(false);
  });

  it('rejects an unrecognised range value', () => {
    expect(videoStream.safeParse({ range: 'Dolby Vision' }).success).toBe(
      false,
    );
  });
});

describe('mediaProfile', () => {
  it('defaults audio and subtitles to [] when omitted', () => {
    const parsed = mediaProfile.parse({});
    expect(parsed.audio).toEqual([]);
    expect(parsed.subtitles).toEqual([]);
  });

  it('round-trips the full S6.3.3 media example', () => {
    const input = {
      container: 'mkv',
      size_bytes: 24800000000,
      runtime_sec: 8160,
      video: {
        codec: 'hevc',
        width: 3840,
        height: 2160,
        range: 'HDR10' as const,
        bitrate: 22000000,
      },
      audio: [
        { lang: 'en', codec: 'truehd', channels: 8, default: true },
        { lang: 'de', codec: 'eac3', channels: 6, default: false },
      ],
      subtitles: [
        { lang: 'de', codec: 'subrip', forced: false, external: true },
        { lang: 'en', codec: 'pgssub', forced: true, external: false },
      ],
    };
    expect(mediaProfile.parse(input)).toEqual(input);
  });

  it('rejects a negative size_bytes or runtime_sec', () => {
    expect(mediaProfile.safeParse({ size_bytes: -1 }).success).toBe(false);
    expect(mediaProfile.safeParse({ runtime_sec: -1 }).success).toBe(false);
  });
});
