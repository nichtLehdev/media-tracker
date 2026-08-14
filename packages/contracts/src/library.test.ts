import { describe, expect, it } from 'vitest';
import {
  libraryDeltaRequest,
  libraryDeltaResponse,
  libraryItem,
  librarySyncChunkRequest,
  librarySyncFinishResponse,
  librarySyncStartResponse,
} from './library.js';

const validItem = {
  jellyfin_item_id: '8d9...',
  item_type: 'Episode' as const,
  name: 'Rogue One',
  production_year: 2016,
  series_name: 'Andor',
  season: 1,
  episode: 3,
  provider_ids: { Tmdb: '330459', Imdb: 'tt3748528' },
  series_provider_ids: { Tmdb: '83867' },
};

/** S6.3.3 full example, media included. */
const itemWithMedia = {
  ...validItem,
  media: {
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
  },
};

describe('libraryItem', () => {
  it('round-trips the S6.3.3 example without media', () => {
    expect(libraryItem.parse(validItem)).toEqual(validItem);
  });

  it('accepts payloads with media omitted (S6.3.3: off when ReportMediaProfile is disabled)', () => {
    const parsed = libraryItem.parse(validItem);
    expect(parsed.media).toBeUndefined();
  });

  it('round-trips the S6.3.3 example with a full media profile', () => {
    const parsed = libraryItem.parse(itemWithMedia);
    expect(parsed.media).toEqual(itemWithMedia.media);
  });

  it('requires jellyfin_item_id, item_type, and name', () => {
    const { name: _name, ...missingName } = validItem;
    expect(libraryItem.safeParse(missingName).success).toBe(false);
  });

  it('defaults provider_ids and series_provider_ids to {} when omitted', () => {
    const minimal = {
      jellyfin_item_id: 'x',
      item_type: 'Movie' as const,
      name: 'Arrival',
    };
    const parsed = libraryItem.parse(minimal);
    expect(parsed.provider_ids).toEqual({});
    expect(parsed.series_provider_ids).toEqual({});
  });
});

describe('libraryDeltaRequest', () => {
  it('defaults added/removed/updated to [] when omitted', () => {
    const parsed = libraryDeltaRequest.parse({
      jellyfin_user_id: 'f1c2...',
    });
    expect(parsed.added).toEqual([]);
    expect(parsed.removed).toEqual([]);
    expect(parsed.updated).toEqual([]);
  });

  it('round-trips a delta with added, removed, and updated items', () => {
    const request = {
      jellyfin_user_id: 'f1c2...',
      added: [validItem],
      removed: [{ jellyfin_item_id: '8d9...' }],
      updated: [itemWithMedia],
    };
    expect(libraryDeltaRequest.parse(request)).toEqual(request);
  });

  it('rejects an added item over the 2000-item cap', () => {
    const added = Array.from({ length: 2001 }, () => validItem);
    expect(
      libraryDeltaRequest.safeParse({
        jellyfin_user_id: 'f1c2...',
        added,
      }).success,
    ).toBe(false);
  });

  it('accepts an added array at exactly the 2000-item cap', () => {
    const added = Array.from({ length: 2000 }, () => validItem);
    expect(
      libraryDeltaRequest.safeParse({
        jellyfin_user_id: 'f1c2...',
        added,
      }).success,
    ).toBe(true);
  });

  it('rejects a removed array over the 5000-item cap', () => {
    const removed = Array.from({ length: 5001 }, (_, i) => ({
      jellyfin_item_id: `item-${i}`,
    }));
    expect(
      libraryDeltaRequest.safeParse({
        jellyfin_user_id: 'f1c2...',
        removed,
      }).success,
    ).toBe(false);
  });
});

describe('libraryDeltaResponse', () => {
  it('defaults quarantined to false when omitted', () => {
    const parsed = libraryDeltaResponse.parse({
      added: 3,
      removed: 1,
      updated: 0,
      unmatched: 0,
    });
    expect(parsed.quarantined).toBe(false);
  });
});

describe('librarySyncChunkRequest', () => {
  it('rejects an empty items array', () => {
    expect(
      librarySyncChunkRequest.safeParse({
        sync_id: '123e4567-e89b-12d3-a456-426614174000',
        items: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an items array over the 500-item cap', () => {
    const items = Array.from({ length: 501 }, () => validItem);
    expect(
      librarySyncChunkRequest.safeParse({
        sync_id: '123e4567-e89b-12d3-a456-426614174000',
        items,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-uuid sync_id', () => {
    expect(
      librarySyncChunkRequest.safeParse({
        sync_id: 'not-a-uuid',
        items: [validItem],
      }).success,
    ).toBe(false);
  });
});

describe('librarySyncStartResponse / librarySyncFinishResponse', () => {
  it('requires sync_id to be a uuid', () => {
    expect(
      librarySyncStartResponse.safeParse({ sync_id: 'abc' }).success,
    ).toBe(false);
    expect(
      librarySyncStartResponse.safeParse({
        sync_id: '123e4567-e89b-12d3-a456-426614174000',
      }).success,
    ).toBe(true);
  });

  it('defaults quarantined to false on finish', () => {
    const parsed = librarySyncFinishResponse.parse({
      added: 41,
      removed: 7,
      unmatched: 12,
    });
    expect(parsed.quarantined).toBe(false);
  });
});
