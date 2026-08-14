import { z } from 'zod';
import {
  itemType,
  jellyfinItemId,
  jellyfinUserId,
  providerIds,
  timestamp,
} from './common.js';

export const ingestEventType = z.enum([
  'playback.start',
  'playback.progress',
  'playback.stop',
  /** The only watched signal. Jellyfin's own PlaybackFinished, not a derived %. */
  'item.played',
]);
export type IngestEventType = z.infer<typeof ingestEventType>;

export const ingestItem = z.object({
  jellyfin_item_id: jellyfinItemId,
  item_type: itemType,
  name: z.string().min(1),
  production_year: z.number().int().min(1870).max(2200).nullish(),
  series_name: z.string().nullish(),
  season: z.number().int().min(0).nullish(),
  episode: z.number().int().min(0).nullish(),
  provider_ids: providerIds.default({}),
  series_provider_ids: providerIds.default({}),
});
export type IngestItem = z.infer<typeof ingestItem>;

export const ingestEvent = z.object({
  idempotency_key: z.string().min(1).max(128),
  /**
   * Raw Jellyfin user id. The payload never asserts a tracker identity (C2);
   * the tracker maps this through server_accounts for the authenticated server.
   */
  jellyfin_user_id: jellyfinUserId,
  type: ingestEventType,
  occurred_at: timestamp,
  session_id: z.string().max(128).nullish(),
  item: ingestItem,
  position_sec: z.number().int().nonnegative().nullish(),
  runtime_sec: z.number().int().nonnegative().nullish(),
  is_paused: z.boolean().nullish(),
  device: z.string().max(128).nullish(),
});
export type IngestEvent = z.infer<typeof ingestEvent>;

export const ingestRequest = z.object({
  events: z.array(ingestEvent).min(1).max(200),
});
export type IngestRequest = z.infer<typeof ingestRequest>;

/**
 * Per-event outcome. The plugin may only drop an event the tracker explicitly
 * accepted, or rejected with `permanent: true`. Anything else must be retried.
 */
export const ingestErrorReason = z.enum([
  'unlinked_account',
  'unmatched',
  'invalid',
  'internal',
]);
export type IngestErrorReason = z.infer<typeof ingestErrorReason>;

export const ingestError = z.object({
  idempotency_key: z.string(),
  reason: ingestErrorReason,
  permanent: z.boolean(),
  message: z.string().optional(),
});

export const ingestResponse = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  errors: z.array(ingestError).default([]),
});
export type IngestResponse = z.infer<typeof ingestResponse>;
