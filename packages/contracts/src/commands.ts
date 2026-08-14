import { z } from 'zod';

/**
 * S6.4. The only way the tracker reaches a member's LAN: the plugin long-polls
 * for work rather than the tracker connecting inbound (C1).
 */
export const commandKind = z.enum([
  'seerr.request',
  'seerr.status',
  'library.resync',
]);
export type CommandKind = z.infer<typeof commandKind>;

export const seerrRequestPayload = z.object({
  request_id: z.uuid(),
  base_url: z.url(),
  api_key: z.string(),
  media_type: z.enum(['movie', 'tv']),
  tmdb_id: z.number().int().positive(),
  seasons: z.array(z.number().int().nonnegative()).optional(),
});

export const seerrStatusPayload = z.object({
  request_id: z.uuid(),
  base_url: z.url(),
  api_key: z.string(),
  remote_request_id: z.string(),
});

export const libraryResyncPayload = z.object({
  jellyfin_user_id: z.string().optional(),
});

export const pluginCommand = z.object({
  id: z.uuid(),
  kind: commandKind,
  payload: z.unknown(),
});
export type PluginCommand = z.infer<typeof pluginCommand>;

export const commandPollResponse = z.object({
  commands: z.array(pluginCommand),
});

export const commandResultRequest = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string().max(2000) }),
]);
export type CommandResultRequest = z.infer<typeof commandResultRequest>;
