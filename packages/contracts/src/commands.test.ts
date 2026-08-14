import { describe, expect, it } from 'vitest';
import {
  commandKind,
  commandResultRequest,
  pluginCommand,
  seerrRequestPayload,
  seerrStatusPayload,
} from './commands.js';

describe('commandKind', () => {
  it('accepts the three documented kinds', () => {
    for (const kind of ['seerr.request', 'seerr.status', 'library.resync']) {
      expect(commandKind.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects an undocumented kind', () => {
    expect(commandKind.safeParse('seerr.cancel').success).toBe(false);
  });
});

describe('seerrRequestPayload', () => {
  const valid = {
    request_id: '123e4567-e89b-12d3-a456-426614174000',
    base_url: 'https://seerr.example.com',
    api_key: 'key',
    media_type: 'movie' as const,
    tmdb_id: 330459,
    seasons: [1, 2],
  };

  it('round-trips a valid request', () => {
    expect(seerrRequestPayload.parse(valid)).toEqual(valid);
  });

  it('requires tmdb_id to be a positive integer', () => {
    expect(
      seerrRequestPayload.safeParse({ ...valid, tmdb_id: 0 }).success,
    ).toBe(false);
    expect(
      seerrRequestPayload.safeParse({ ...valid, tmdb_id: -5 }).success,
    ).toBe(false);
  });

  it('only accepts movie or tv for media_type', () => {
    expect(
      seerrRequestPayload.safeParse({ ...valid, media_type: 'show' })
        .success,
    ).toBe(false);
  });

  it('allows seasons to be omitted for a movie request', () => {
    const { seasons: _seasons, ...withoutSeasons } = valid;
    expect(seerrRequestPayload.safeParse(withoutSeasons).success).toBe(
      true,
    );
  });
});

describe('seerrStatusPayload', () => {
  it('requires base_url to be a valid URL', () => {
    expect(
      seerrStatusPayload.safeParse({
        request_id: '123e4567-e89b-12d3-a456-426614174000',
        base_url: 'not-a-url',
        api_key: 'key',
        remote_request_id: '42',
      }).success,
    ).toBe(false);
  });
});

describe('pluginCommand', () => {
  it('accepts an arbitrary payload shape (payload is z.unknown, kind-dependent)', () => {
    const command = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      kind: 'library.resync' as const,
      payload: { jellyfin_user_id: 'f1c2' },
    };
    expect(pluginCommand.safeParse(command).success).toBe(true);
  });

  it('still requires id to be a uuid and kind to be a known kind', () => {
    expect(
      pluginCommand.safeParse({
        id: 'not-a-uuid',
        kind: 'library.resync',
        payload: null,
      }).success,
    ).toBe(false);
    expect(
      pluginCommand.safeParse({
        id: '123e4567-e89b-12d3-a456-426614174000',
        kind: 'unknown.kind',
        payload: null,
      }).success,
    ).toBe(false);
  });
});

describe('commandResultRequest', () => {
  it('accepts an ok:true result with no result payload', () => {
    expect(commandResultRequest.safeParse({ ok: true }).success).toBe(true);
  });

  it('accepts an ok:true result with an arbitrary result payload', () => {
    expect(
      commandResultRequest.safeParse({ ok: true, result: { seerr_id: 42 } })
        .success,
    ).toBe(true);
  });

  it('requires an error message when ok is false', () => {
    expect(commandResultRequest.safeParse({ ok: false }).success).toBe(
      false,
    );
    expect(
      commandResultRequest.safeParse({ ok: false, error: 'seerr 500' })
        .success,
    ).toBe(true);
  });

  it('rejects an error message over 2000 characters', () => {
    expect(
      commandResultRequest.safeParse({ ok: false, error: 'x'.repeat(2001) })
        .success,
    ).toBe(false);
  });

  it('rejects a non-boolean discriminant', () => {
    expect(commandResultRequest.safeParse({ ok: 'true' }).success).toBe(
      false,
    );
  });
});
