import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Database } from './client.js';
import * as schema from './schema/index.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

export interface TestDatabase {
  db: Database;
  /** Raw handle, for the occasional statement Drizzle cannot express. */
  sql: postgres.Sql;
  name: string;
  /** Closes the pool and drops the database. Always call this. */
  drop(): Promise<void>;
}

/**
 * True when a Postgres is configured. Integration tests skip rather than fail
 * without one, so `pnpm test` still works on a machine with no database.
 */
export function hasTestDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Creates a throwaway database, applies every migration to it, and hands back a
 * Drizzle client. Each test file gets its own database, so files can run in
 * parallel and nothing touches the developer's own data.
 *
 * Migrations are applied rather than `drizzle-kit push`ing the schema, so these
 * tests exercise the same SQL that production will run.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const name = `mt_test_${randomBytes(6).toString('hex')}`;

  const admin = postgres(url, { max: 1 });
  try {
    // The name is generated here, never user input, but it is still quoted as
    // an identifier because CREATE DATABASE takes no parameters.
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const testUrl = new URL(url);
  testUrl.pathname = `/${name}`;

  const sql = postgres(testUrl.toString(), {
    max: 1,
    prepare: false,
    // TRUNCATE ... CASCADE in test setup emits a NOTICE per cascaded table.
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' });

  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    await sql.end();
    await dropDatabase(url, name);
    throw err;
  }

  return {
    db,
    sql,
    name,
    async drop() {
      await sql.end();
      await dropDatabase(url, name);
    },
  };
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1 });
  try {
    // FORCE terminates any connection the test left behind; without it a
    // leaked handle makes the drop hang and the next run collide.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
