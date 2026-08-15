import { ingestRequest } from '@media-tracker/contracts';
import { db } from '@media-tracker/db';
import { json, parseBody, problem } from '@/server/api';
import { authenticateServer, recordServerHeartbeat } from '@/server/plugin-auth';
import { ingestEvents } from '@/server/ingest';
import { resolver } from '@/server/media';
import { rateLimit } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * S6.2. Batched, idempotent, and never trusting the identity in the payload.
 *
 * Always 202 once the batch is authenticated and parses: partial success is
 * the normal case and is reported per event, so a single unmatched title must
 * not fail the other 199.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateServer(req);
  if (!auth.ok) return auth.response;

  const limit = rateLimit(`ingest:${auth.server.id}`, 60, 60_000);
  if (!limit.ok) {
    return problem(429, 'rate_limited', { retry_after: limit.retryAfterSeconds });
  }

  await recordServerHeartbeat(auth.server.id, req);

  const parsed = await parseBody(req, ingestRequest);
  if (!parsed.ok) return parsed.response;

  const media = resolver();
  const result = await ingestEvents(
    { db: db(), resolve: (input) => media.resolve(input) },
    auth.server.id,
    parsed.data.events,
  );

  return json(result, { status: 202 });
}
