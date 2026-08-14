import { describe, expect, it } from 'vitest';
import {
  ingestError,
  ingestErrorReason,
  ingestEvent,
  ingestEventType,
  ingestItem,
  ingestRequest,
  ingestResponse,
} from './ingest.js';

/** S6.2 wire example, trimmed to what the schema actually requires. */
const validItem = {
  jellyfin_item_id: '8d9...',
  item_type: 'Episode' as const,
  name: 'Rogue One',
  production_year: 2016,
  series_name: 'Andor',
  season: 1,
  episode: 3,
  provider_ids: { Tmdb: '1396', Imdb: 'tt0903747', Tvdb: '81189' },
  series_provider_ids: { Tmdb: '83867' },
};

const validEvent = {
  idempotency_key: 'uuid',
  jellyfin_user_id: 'f1c2...',
  type: 'playback.start' as const,
  occurred_at: '2026-08-13T20:11:04Z',
  session_id: 'abc123',
  item: validItem,
  position_sec: 812,
  runtime_sec: 2610,
  is_paused: false,
  device: 'webOS',
};

describe('ingestEventType', () => {
  it('accepts the four documented event types', () => {
    for (const type of [
      'playback.start',
      'playback.progress',
      'playback.stop',
      'item.played',
    ]) {
      expect(ingestEventType.safeParse(type).success).toBe(true);
    }
  });

  it('rejects a derived-from-percentage event that is not in the spec', () => {
    // S6.2: "item.played is the only watched signal" -- there is deliberately
    // no "playback.finished" or similar synthetic type.
    expect(ingestEventType.safeParse('playback.finished').success).toBe(
      false,
    );
  });
});

describe('ingestItem', () => {
  it('round-trips the full S6.2 example item', () => {
    expect(ingestItem.parse(validItem)).toEqual(validItem);
  });

  it('requires jellyfin_item_id, item_type, and name', () => {
    const { jellyfin_item_id: _a, ...missingId } = validItem;
    expect(ingestItem.safeParse(missingId).success).toBe(false);
    const { name: _b, ...missingName } = validItem;
    expect(ingestItem.safeParse(missingName).success).toBe(false);
  });

  it('only accepts Movie or Episode for item_type', () => {
    expect(
      ingestItem.safeParse({ ...validItem, item_type: 'Series' }).success,
    ).toBe(false);
  });

  it('defaults provider_ids and series_provider_ids to {} when omitted', () => {
    const minimal = {
      jellyfin_item_id: 'x',
      item_type: 'Movie' as const,
      name: 'Arrival',
    };
    const parsed = ingestItem.parse(minimal);
    expect(parsed.provider_ids).toEqual({});
    expect(parsed.series_provider_ids).toEqual({});
  });

  it('allows series_name, season, and episode to be omitted or null (movies have none)', () => {
    const movie = {
      jellyfin_item_id: 'x',
      item_type: 'Movie' as const,
      name: 'Arrival',
      series_name: null,
      season: null,
      episode: null,
    };
    expect(ingestItem.safeParse(movie).success).toBe(true);
  });

  it('rejects a negative season or episode number', () => {
    expect(
      ingestItem.safeParse({ ...validItem, season: -1 }).success,
    ).toBe(false);
    expect(
      ingestItem.safeParse({ ...validItem, episode: -1 }).success,
    ).toBe(false);
  });

  it('rejects a production_year outside the plausible film range', () => {
    expect(
      ingestItem.safeParse({ ...validItem, production_year: 1800 }).success,
    ).toBe(false);
    expect(
      ingestItem.safeParse({ ...validItem, production_year: 2300 }).success,
    ).toBe(false);
  });
});

describe('ingestEvent', () => {
  it('round-trips the full S6.2 example event', () => {
    expect(ingestEvent.parse(validEvent)).toEqual(validEvent);
  });

  it('requires idempotency_key, jellyfin_user_id, type, occurred_at, and item', () => {
    const { idempotency_key: _a, ...missingKey } = validEvent;
    expect(ingestEvent.safeParse(missingKey).success).toBe(false);
    const { occurred_at: _b, ...missingOccurred } = validEvent;
    expect(ingestEvent.safeParse(missingOccurred).success).toBe(false);
  });

  it('allows session_id, position_sec, runtime_sec, is_paused, and device to be omitted', () => {
    const minimal = {
      idempotency_key: 'uuid',
      jellyfin_user_id: 'f1c2...',
      type: 'item.played' as const,
      occurred_at: '2026-08-13T20:11:04Z',
      item: validItem,
    };
    expect(ingestEvent.safeParse(minimal).success).toBe(true);
  });

  it('rejects a negative position_sec or runtime_sec', () => {
    expect(
      ingestEvent.safeParse({ ...validEvent, position_sec: -1 }).success,
    ).toBe(false);
  });
});

describe('ingestRequest', () => {
  it('rejects an empty events array', () => {
    expect(ingestRequest.safeParse({ events: [] }).success).toBe(false);
  });

  it('accepts exactly 200 events (S6.2 batch cap)', () => {
    const events = Array.from({ length: 200 }, () => validEvent);
    expect(ingestRequest.safeParse({ events }).success).toBe(true);
  });

  it('rejects 201 events', () => {
    const events = Array.from({ length: 201 }, () => validEvent);
    expect(ingestRequest.safeParse({ events }).success).toBe(false);
  });
});

describe('ingestErrorReason / ingestError / ingestResponse', () => {
  it('accepts the four documented reasons', () => {
    for (const reason of [
      'unlinked_account',
      'unmatched',
      'invalid',
      'internal',
    ]) {
      expect(ingestErrorReason.safeParse(reason).success).toBe(true);
    }
  });

  it('rejects an undocumented reason', () => {
    expect(ingestErrorReason.safeParse('rate_limited').success).toBe(false);
  });

  it('requires permanent to be an explicit boolean (retry contract, S6.2)', () => {
    const withoutPermanent = {
      idempotency_key: 'k',
      reason: 'invalid' as const,
    };
    expect(ingestError.safeParse(withoutPermanent).success).toBe(false);
  });

  it('ingestResponse defaults errors to [] when omitted', () => {
    const parsed = ingestResponse.parse({
      accepted: 1,
      rejected: 0,
      unmatched: 0,
    });
    expect(parsed.errors).toEqual([]);
  });
});
