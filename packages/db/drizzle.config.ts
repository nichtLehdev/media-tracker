import { defineConfig } from 'drizzle-kit';

// drizzle-kit does not read .env itself, and this package is usually invoked
// from the repo root (`pnpm db:migrate`), where the shell has no DATABASE_URL.
// `.env` here is a symlink to the root one, same as apps/web and apps/worker.
// In production the migrate container gets DATABASE_URL from the environment
// and ships no .env file, so a missing file is not an error.
try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch {
  // No .env file: fall back to the ambient environment.
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to the repo root as .env, or ' +
      'export DATABASE_URL before running drizzle-kit.',
  );
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
