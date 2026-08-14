import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { UserConfig } from 'vitest/config';

/**
 * Every package's vitest config extends this. Its only real job is loading the
 * root `.env`: vitest does not read it, and the integration tests need
 * DATABASE_URL. Tests skip themselves when it is absent (see hasTestDatabase).
 */
const rootEnv = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.env',
);

try {
  process.loadEnvFile(rootEnv);
} catch {
  // No .env: CI passes DATABASE_URL in the environment, or tests skip.
}

export const sharedTest: UserConfig['test'] = {
  passWithNoTests: true,
  // Integration tests create a database each; the default pool would open a
  // worker per core and swamp a local Postgres.
  fileParallelism: true,
  maxConcurrency: 4,
  testTimeout: 30_000,
  hookTimeout: 60_000,
};
