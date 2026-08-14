import { describe, expect, it } from 'vitest';
import { posterUrl, TMDB_IMAGE_BASE } from './client.js';

/**
 * Only `posterUrl` is covered here -- it is the one pure, dependency-free
 * function in this file. `TmdbClient` itself talks to the network and is out
 * of scope for unit tests (see packages/tmdb/src/client.ts).
 */
describe('posterUrl', () => {
  it('builds a w342 URL by default', () => {
    expect(posterUrl('/abc123.jpg')).toBe(
      `${TMDB_IMAGE_BASE}/w342/abc123.jpg`,
    );
  });

  it('honours an explicit size', () => {
    expect(posterUrl('/abc123.jpg', 'w500')).toBe(
      `${TMDB_IMAGE_BASE}/w500/abc123.jpg`,
    );
    expect(posterUrl('/abc123.jpg', 'original')).toBe(
      `${TMDB_IMAGE_BASE}/original/abc123.jpg`,
    );
  });

  it('returns null for a null or undefined poster path (item has no poster)', () => {
    expect(posterUrl(null)).toBeNull();
    expect(posterUrl(undefined)).toBeNull();
  });
});
