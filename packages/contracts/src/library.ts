import { z } from 'zod';
import { itemType, jellyfinItemId, jellyfinUserId, providerIds } from './common.js';
import { mediaProfile } from './media.js';

/** S6.3.3. Never carries file paths or filenames. */
export const libraryItem = z.object({
  jellyfin_item_id: jellyfinItemId,
  item_type: itemType,
  name: z.string().min(1),
  production_year: z.number().int().min(1870).max(2200).nullish(),
  series_name: z.string().nullish(),
  season: z.number().int().min(0).nullish(),
  episode: z.number().int().min(0).nullish(),
  provider_ids: providerIds.default({}),
  series_provider_ids: providerIds.default({}),
  /** Omitted when the plugin has ReportMediaProfile off. */
  media: mediaProfile.optional(),
});
export type LibraryItem = z.infer<typeof libraryItem>;

export const libraryRemoval = z.object({ jellyfin_item_id: jellyfinItemId });

/** S6.3.1 */
export const libraryDeltaRequest = z.object({
  jellyfin_user_id: jellyfinUserId,
  added: z.array(libraryItem).max(2000).default([]),
  removed: z.array(libraryRemoval).max(5000).default([]),
  updated: z.array(libraryItem).max(2000).default([]),
});
export type LibraryDeltaRequest = z.infer<typeof libraryDeltaRequest>;

export const libraryDeltaResponse = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  /**
   * True when the removal set tripped the mass-removal safety valve (S7.6).
   * The plugin must treat this as success and stop retrying -- the batch is
   * held for the owner to confirm, not lost.
   */
  quarantined: z.boolean().default(false),
});
export type LibraryDeltaResponse = z.infer<typeof libraryDeltaResponse>;

/** S6.3.2 */
export const librarySyncStartRequest = z.object({
  jellyfin_user_id: jellyfinUserId,
  estimated_count: z.number().int().nonnegative().optional(),
});
export const librarySyncStartResponse = z.object({ sync_id: z.uuid() });

export const librarySyncChunkRequest = z.object({
  sync_id: z.uuid(),
  items: z.array(libraryItem).min(1).max(500),
});
export const librarySyncChunkResponse = z.object({
  accepted: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
});

export const librarySyncFinishRequest = z.object({ sync_id: z.uuid() });
export const librarySyncFinishResponse = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  quarantined: z.boolean().default(false),
});
