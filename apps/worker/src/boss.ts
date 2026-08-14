import { PgBoss } from 'pg-boss';
import { env } from './env.js';

/**
 * pg-boss owns its own schema and connection pool. It is deliberately separate
 * from the Drizzle client: job state is pg-boss's business, and mixing the two
 * makes migrations harder to reason about.
 *
 * Retention is a per-queue setting in pg-boss 12, so it is configured where
 * each queue is created rather than here.
 */
export function createBoss(): PgBoss {
  return new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: 'pgboss',
  });
}
