import { z } from 'zod';

/**
 * Technical profile of a file, read out of Jellyfin's own ffprobe results
 * (S7.7). Never contains paths or filenames.
 *
 * `lang` is always ISO 639-1, normalised *in the plugin*, or the literal
 * string `und`. "Has a track of unknown language" is meaningfully different
 * from "has no track", so `und` is preserved rather than dropped.
 */
export const videoRange = z.enum(['SDR', 'HDR10', 'HDR10+', 'DV', 'HLG']);
export type VideoRange = z.infer<typeof videoRange>;

export const langCode = z
  .string()
  .regex(/^([a-z]{2}|und)$/, 'expected ISO 639-1 or "und"');

export const audioStream = z.object({
  lang: langCode,
  codec: z.string().optional(),
  channels: z.number().int().positive().optional(),
  default: z.boolean().optional(),
});

export const subtitleStream = z.object({
  lang: langCode,
  codec: z.string().optional(),
  forced: z.boolean().optional(),
  external: z.boolean().optional(),
});

export const videoStream = z.object({
  codec: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  range: videoRange.optional(),
  bitrate: z.number().int().nonnegative().optional(),
});

export const mediaProfile = z.object({
  container: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  runtime_sec: z.number().int().nonnegative().optional(),
  video: videoStream.optional(),
  audio: z.array(audioStream).default([]),
  subtitles: z.array(subtitleStream).default([]),
});

export type MediaProfile = z.infer<typeof mediaProfile>;
