import { z } from 'zod';

/**
 * S4: everything comes from the environment, and nothing security-relevant
 * has a default. Parsed once, at first import, so a misconfigured deploy
 * fails loudly at boot rather than at the first request that needs the value.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),

  AUTH_SECRET: z.string().min(16),
  AUTH_DISCORD_ID: z.string().min(1),
  AUTH_DISCORD_SECRET: z.string().min(1),
  DISCORD_GUILD_ID: z.string().regex(/^\d{5,25}$/, 'expected a Discord snowflake'),

  DISCORD_ANNOUNCE_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  BOT_API_TOKEN: z.string().min(16).optional().or(z.literal('')),

  TMDB_API_KEY: z.string().optional().or(z.literal('')),

  SECRETS_ENC_KEY: z
    .string()
    .refine(
      (v) => v === '' || Buffer.from(v, 'base64').length === 32,
      'expected 32 bytes of base64',
    )
    .optional(),

  DEFAULT_SEERR_BASE_URL: z.string().optional().or(z.literal('')),
  DEFAULT_SEERR_API_KEY: z.string().optional().or(z.literal('')),

  PUBLIC_BASE_URL: z.string().url(),
});

/**
 * `next build` imports server modules to collect page data, so a build in CI
 * or a Docker image layer would otherwise need the full production secret set
 * just to compile. This flag is for that, and only that -- at runtime the
 * parse below is strict and a misconfigured deploy fails at boot.
 */
const SKIP = process.env.SKIP_ENV_VALIDATION === '1';

const parsed = SKIP
  ? ({ success: true, data: process.env as unknown } as const)
  : schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data as z.infer<typeof schema>;
