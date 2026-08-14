import { z } from 'zod';

/**
 * S6.1. The owner generates a one-time code on the website and pastes it into
 * the plugin's config page. Codes are single-use and expire in 15 minutes.
 */
export const registrationCodePattern = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export const serverRegisterRequest = z.object({
  registration_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(registrationCodePattern, 'expected a code in the form ABCD-EFGH'),
  name: z.string().trim().min(1).max(64),
  jellyfin_version: z.string().max(32).optional(),
  plugin_version: z.string().max(32).optional(),
});
export type ServerRegisterRequest = z.infer<typeof serverRegisterRequest>;

export const serverRegisterResponse = z.object({
  server_id: z.uuid(),
  /** Returned exactly once. Stored argon2id-hashed; not recoverable. */
  server_secret: z.string(),
});
export type ServerRegisterResponse = z.infer<typeof serverRegisterResponse>;
