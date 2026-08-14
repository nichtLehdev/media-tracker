import { z } from 'zod';
import { timestamp } from './common.js';

/** S6.5. Consumed by the existing community Discord bot over a static token. */
export const nowPlayingSession = z.object({
  discord_id: z.string(),
  display_name: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  position_sec: z.number().int().nonnegative().nullable(),
  runtime_sec: z.number().int().nonnegative().nullable(),
  is_paused: z.boolean(),
  server_name: z.string(),
  poster_url: z.string().nullable(),
});

export const nowPlayingResponse = z.object({
  sessions: z.array(nowPlayingSession),
});
export type NowPlayingResponse = z.infer<typeof nowPlayingResponse>;

export const recentWatch = z.object({
  title: z.string(),
  subtitle: z.string().nullable(),
  kind: z.enum(['movie', 'show']),
  tmdb_id: z.number().int(),
  watched_at: timestamp,
  is_rewatch: z.boolean(),
  poster_url: z.string().nullable(),
});

export const recentResponse = z.object({
  display_name: z.string(),
  watches: z.array(recentWatch),
});

export const upcomingScreening = z.object({
  id: z.uuid(),
  title: z.string(),
  subtitle: z.string().nullable(),
  starts_at: timestamp,
  created_by: z.string(),
  participant_count: z.number().int().nonnegative(),
  url: z.string(),
});

export const upcomingScreeningsResponse = z.object({
  screenings: z.array(upcomingScreening),
});
