import { describe, expect, it } from 'vitest';
import {
  nowPlayingSession,
  recentWatch,
  upcomingScreening,
} from './bot.js';

describe('nowPlayingSession', () => {
  const valid = {
    discord_id: '123',
    display_name: 'lars',
    title: 'Rogue One',
    subtitle: null,
    position_sec: 812,
    runtime_sec: 2610,
    is_paused: false,
    server_name: 'Living room',
    poster_url: null,
  };

  it('round-trips a full session', () => {
    expect(nowPlayingSession.parse(valid)).toEqual(valid);
  });

  it('requires nullable fields to be present as explicit null, not omitted', () => {
    // subtitle/position_sec/runtime_sec/poster_url are .nullable(), not
    // .nullish() -- the bot always has an opinion (even if it's "none").
    const { subtitle: _subtitle, ...withoutSubtitle } = valid;
    expect(nowPlayingSession.safeParse(withoutSubtitle).success).toBe(false);
  });

  it('accepts a subtitle and poster when present', () => {
    const withValues = {
      ...valid,
      subtitle: 'S1E3 - Reformation',
      poster_url: 'https://image.tmdb.org/t/p/w342/abc.jpg',
    };
    expect(nowPlayingSession.safeParse(withValues).success).toBe(true);
  });
});

describe('recentWatch', () => {
  const valid = {
    title: 'Rogue One',
    subtitle: null,
    kind: 'movie' as const,
    tmdb_id: 330459,
    watched_at: '2026-08-13T20:11:04Z',
    is_rewatch: false,
    poster_url: null,
  };

  it('round-trips a valid watch', () => {
    expect(recentWatch.parse(valid)).toEqual(valid);
  });

  it('only accepts movie or show for kind', () => {
    expect(
      recentWatch.safeParse({ ...valid, kind: 'episode' }).success,
    ).toBe(false);
  });

  it('requires watched_at to be an offset timestamp', () => {
    expect(
      recentWatch.safeParse({ ...valid, watched_at: '2026-08-13' }).success,
    ).toBe(false);
  });
});

describe('upcomingScreening', () => {
  it('requires id to be a uuid', () => {
    expect(
      upcomingScreening.safeParse({
        id: 'not-a-uuid',
        title: 'Movie night',
        subtitle: null,
        starts_at: '2026-08-13T20:11:04Z',
        created_by: 'lars',
        participant_count: 3,
        url: 'https://tracker.lehdev.de/screenings/abc',
      }).success,
    ).toBe(false);
  });

  it('rejects a negative participant_count', () => {
    expect(
      upcomingScreening.safeParse({
        id: '123e4567-e89b-12d3-a456-426614174000',
        title: 'Movie night',
        subtitle: null,
        starts_at: '2026-08-13T20:11:04Z',
        created_by: 'lars',
        participant_count: -1,
        url: 'https://tracker.lehdev.de/screenings/abc',
      }).success,
    ).toBe(false);
  });
});
