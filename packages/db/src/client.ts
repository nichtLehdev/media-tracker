import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export interface CreateDatabaseOptions {
  url?: string;
  /** Keep this at 1 for one-shot scripts and migrations. */
  max?: number;
}

export function createDatabase(options: CreateDatabaseOptions = {}) {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = postgres(url, {
    max: options.max ?? 10,
    // Dates come back as strings unless asked otherwise; we want Date objects
    // for timestamptz and plain strings for `date` columns.
    prepare: false,
  });

  return drizzle(client, { schema, casing: 'snake_case' });
}

/**
 * Process-wide singleton. Next.js reloads modules in dev, so it is cached on
 * globalThis to avoid exhausting connections across hot reloads.
 */
const globalForDb = globalThis as unknown as { __trackerDb?: Database };

export function db(): Database {
  globalForDb.__trackerDb ??= createDatabase();
  return globalForDb.__trackerDb;
}
