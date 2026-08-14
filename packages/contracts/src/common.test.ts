import { describe, expect, it } from 'vitest';
import {
  itemType,
  jellyfinItemId,
  jellyfinUserId,
  providerIds,
  timestamp,
} from './common.js';

describe('timestamp', () => {
  it('accepts a UTC offset written as Z', () => {
    expect(timestamp.safeParse('2026-08-13T20:11:04Z').success).toBe(true);
  });

  it('accepts an explicit numeric offset', () => {
    expect(timestamp.safeParse('2026-08-13T20:11:04+02:00').success).toBe(
      true,
    );
  });

  it('accepts fractional seconds', () => {
    expect(timestamp.safeParse('2026-08-13T20:11:04.123Z').success).toBe(
      true,
    );
  });

  it('rejects a timestamp with no offset at all', () => {
    // { offset: true } widens beyond bare "Z" to any offset, it does not make
    // the offset optional.
    expect(timestamp.safeParse('2026-08-13T20:11:04').success).toBe(false);
  });

  it('rejects a non-ISO string', () => {
    expect(timestamp.safeParse('13 August 2026').success).toBe(false);
  });
});

describe('providerIds', () => {
  it('round-trips the three named providers', () => {
    const input = { Tmdb: '1396', Imdb: 'tt0903747', Tvdb: '81189' };
    expect(providerIds.parse(input)).toEqual(input);
  });

  it('parses to an empty object when nothing is supplied', () => {
    expect(providerIds.parse({})).toEqual({});
  });

  it('preserves unnamed provider keys via the catchall (e.g. TvRage, AniDb)', () => {
    const input = { Tmdb: '1396', TvRage: '12345', AniDb: '999' };
    expect(providerIds.parse(input)).toEqual(input);
  });

  it('rejects a non-string value even for an unnamed key', () => {
    // catchall(z.string()) applies to every key the object schema does not
    // name explicitly -- a numeric TvRage id must still arrive as a string.
    const result = providerIds.safeParse({ TvRage: 12345 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string value for a named key', () => {
    expect(providerIds.safeParse({ Tmdb: 1396 }).success).toBe(false);
  });
});

describe('itemType', () => {
  it('accepts Movie and Episode', () => {
    expect(itemType.safeParse('Movie').success).toBe(true);
    expect(itemType.safeParse('Episode').success).toBe(true);
  });

  it('rejects any other casing or kind (e.g. Series, movie)', () => {
    expect(itemType.safeParse('movie').success).toBe(false);
    expect(itemType.safeParse('Series').success).toBe(false);
    expect(itemType.safeParse('Season').success).toBe(false);
  });
});

describe('jellyfinItemId / jellyfinUserId', () => {
  it('accepts a normal opaque id', () => {
    expect(jellyfinItemId.safeParse('8d9c2f1a').success).toBe(true);
    expect(jellyfinUserId.safeParse('f1c2ab34').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(jellyfinItemId.safeParse('').success).toBe(false);
  });

  it('rejects a string over 128 characters', () => {
    expect(jellyfinItemId.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('accepts a string at exactly 128 characters', () => {
    expect(jellyfinItemId.safeParse('a'.repeat(128)).success).toBe(true);
  });
});
