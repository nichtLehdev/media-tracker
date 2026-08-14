import { describe, expect, it } from 'vitest';
import {
  registrationCodePattern,
  serverRegisterRequest,
  serverRegisterResponse,
} from './registration.js';

describe('registrationCodePattern', () => {
  it('matches the ABCD-EFGH shape', () => {
    expect(registrationCodePattern.test('ABCD-EFGH')).toBe(true);
  });

  it('excludes visually-ambiguous characters I, O, 0, 1 (S6.1)', () => {
    expect(registrationCodePattern.test('ABCI-EFGH')).toBe(false);
    expect(registrationCodePattern.test('ABCO-EFGH')).toBe(false);
    expect(registrationCodePattern.test('ABC0-EFGH')).toBe(false);
    expect(registrationCodePattern.test('ABC1-EFGH')).toBe(false);
  });

  it('rejects the wrong shape (no dash, wrong group length)', () => {
    expect(registrationCodePattern.test('ABCDEFGH')).toBe(false);
    expect(registrationCodePattern.test('ABC-EFGH')).toBe(false);
    expect(registrationCodePattern.test('ABCD-EFGHI')).toBe(false);
  });
});

describe('serverRegisterRequest', () => {
  it('accepts a well-formed request', () => {
    const result = serverRegisterRequest.safeParse({
      registration_code: 'ABCD-EFGH',
      name: 'Living room Jellyfin',
      jellyfin_version: '10.9.0',
      plugin_version: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('trims and uppercases a lowercase, padded code before validating it', () => {
    const result = serverRegisterRequest.safeParse({
      registration_code: '  abcd-efgh  ',
      name: 'Living room Jellyfin',
    });
    expect(result.success).toBe(true);
    expect(result.data?.registration_code).toBe('ABCD-EFGH');
  });

  it('rejects a code that is malformed even after normalisation', () => {
    const result = serverRegisterRequest.safeParse({
      registration_code: 'abci-efgh',
      name: 'Living room Jellyfin',
    });
    expect(result.success).toBe(false);
  });

  it('requires a non-empty name up to 64 characters', () => {
    expect(
      serverRegisterRequest.safeParse({
        registration_code: 'ABCD-EFGH',
        name: '',
      }).success,
    ).toBe(false);
    expect(
      serverRegisterRequest.safeParse({
        registration_code: 'ABCD-EFGH',
        name: 'a'.repeat(65),
      }).success,
    ).toBe(false);
  });

  it('allows jellyfin_version and plugin_version to be omitted', () => {
    const result = serverRegisterRequest.safeParse({
      registration_code: 'ABCD-EFGH',
      name: 'Living room Jellyfin',
    });
    expect(result.success).toBe(true);
  });
});

describe('serverRegisterResponse', () => {
  it('requires server_id to be a uuid', () => {
    expect(
      serverRegisterResponse.safeParse({
        server_id: 'not-a-uuid',
        server_secret: 'secret',
      }).success,
    ).toBe(false);
  });

  it('round-trips a valid response', () => {
    const input = {
      server_id: '123e4567-e89b-12d3-a456-426614174000',
      server_secret: 'super-secret-value',
    };
    expect(serverRegisterResponse.parse(input)).toEqual(input);
  });
});
