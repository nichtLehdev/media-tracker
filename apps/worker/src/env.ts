import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DISCORD_ANNOUNCE_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  TMDB_API_KEY: z.string().optional().or(z.literal('')),
  PUBLIC_BASE_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid worker environment:\n${issues}`);
}

export const env = parsed.data;
