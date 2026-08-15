import { db } from '@media-tracker/db';
import { problem } from './api';
import { LibraryError, type LibraryDeps } from './library';
import { resolver } from './media';

/** Shared wiring for the four S6.3 endpoints. */
export function libraryDeps(): LibraryDeps {
  const media = resolver();
  return { db: db(), resolve: (input) => media.resolve(input) };
}

/**
 * LibraryError carries the status the plugin should see. `unlinked_account` in
 * particular is a "skip this Jellyfin user", not a "retry": S7.4 sends every
 * local account because the plugin cannot know which are linked.
 */
export function libraryProblem(err: unknown): Response {
  if (err instanceof LibraryError) return problem(err.status, err.code);
  throw err;
}
