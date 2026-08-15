import { libraryDeltaRequest } from '@media-tracker/contracts';
import { json, parseBody } from '@/server/api';
import { authenticateServer, recordServerHeartbeat } from '@/server/plugin-auth';
import { applyDelta } from '@/server/library';
import { libraryDeps, libraryProblem } from '@/server/library-route';

export const dynamic = 'force-dynamic';

/** S6.3.1. Deltas keep the library fresh within minutes; the snapshot repairs them. */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateServer(req);
  if (!auth.ok) return auth.response;
  await recordServerHeartbeat(auth.server.id, req);

  const parsed = await parseBody(req, libraryDeltaRequest);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await applyDelta(libraryDeps(), auth.server.id, parsed.data);
    return json(result, { status: 202 });
  } catch (err) {
    return libraryProblem(err);
  }
}
