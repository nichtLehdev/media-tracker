import { db } from '@media-tracker/db';
import { MediaResolver, TmdbClient } from '@media-tracker/tmdb';
import { env } from '@/env';

/**
 * S9's resolver, as a process-wide singleton. The resolver keeps an in-flight
 * map that collapses concurrent work on the same title, so one per process is
 * the point -- building a fresh one per request would undo it.
 *
 * Cached on globalThis for the same reason the database client is: Next
 * reloads modules in dev.
 */
const globalForMedia = globalThis as unknown as {
  __trackerResolver?: MediaResolver;
};

export function resolver(): MediaResolver {
  globalForMedia.__trackerResolver ??= new MediaResolver(
    db(),
    new TmdbClient({ apiKey: env.TMDB_API_KEY ?? '' }),
  );
  return globalForMedia.__trackerResolver;
}
