import { librarySyncFinishRequest } from '@media-tracker/contracts';
import { json, parseBody } from '@/server/api';
import { authenticateServer, recordServerHeartbeat } from '@/server/plugin-auth';
import { finishSync } from '@/server/library';
import { libraryDeps, libraryProblem } from '@/server/library-route';

export const dynamic = 'force-dynamic';

/**
 * S6.3.2. Reconciles: entries not confirmed during the run are proposed for
 * removal, and go through the S7.6 safety valve like any other removal.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateServer(req);
  if (!auth.ok) return auth.response;
  await recordServerHeartbeat(auth.server.id, req);

  const parsed = await parseBody(req, librarySyncFinishRequest);
  if (!parsed.ok) return parsed.response;

  try {
    return json(await finishSync(libraryDeps(), auth.server.id, parsed.data));
  } catch (err) {
    return libraryProblem(err);
  }
}
