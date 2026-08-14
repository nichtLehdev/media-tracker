import { db, sql } from '@media-tracker/db';
import { json } from '@/server/api';

export const dynamic = 'force-dynamic';

/** S17. Checks DB connectivity; pg-boss is added with the worker in M3. */
export async function GET(): Promise<Response> {
  const checks: Record<string, 'ok' | 'error'> = {};

  try {
    await db().execute(sql`select 1`);
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');
  return json(
    { status: healthy ? 'ok' : 'degraded', checks },
    { status: healthy ? 200 : 503 },
  );
}
