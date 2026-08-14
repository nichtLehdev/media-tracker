import { z } from 'zod';

/** RFC 3339 timestamp with an explicit offset. Everything on the wire is UTC. */
export const timestamp = z.iso.datetime({ offset: true });

/**
 * Jellyfin's ProviderIds bag. The three we resolve against are named; anything
 * else Jellyfin happens to carry (TvRage, MusicBrainz, AniDb, ...) is preserved
 * rather than rejected, because plugins and metadata providers add keys freely.
 */
export const providerIds = z
  .object({
    Tmdb: z.string().optional(),
    Imdb: z.string().optional(),
    Tvdb: z.string().optional(),
  })
  .catchall(z.string());

export type ProviderIds = z.infer<typeof providerIds>;

export const itemType = z.enum(['Movie', 'Episode']);
export type ItemType = z.infer<typeof itemType>;

/** Jellyfin's own item id. Opaque to us, but stable per server. */
export const jellyfinItemId = z.string().min(1).max(128);
export const jellyfinUserId = z.string().min(1).max(128);
