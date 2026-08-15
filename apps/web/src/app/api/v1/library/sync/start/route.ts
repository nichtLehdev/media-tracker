import { librarySyncStartRequest } from '@media-tracker/contracts';
import { json, parseBody } from '@/server/api';
import { authenticateServer, recordServerHeartbeat } from '@/server/plugin-auth';
import { startSync } from '@/server/library';
import { libraryDeps, libraryProblem } from '@/server/library-route';

export const dynamic = 'force-dynamic';

/** S6.3.2. Opens a snapshot run; `finish` is what makes its removals count. */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateServer(req);
  if (!auth.ok) return auth.response;
  await recordServerHeartbeat(auth.server.id, req);

  const parsed = await parseBody(req, librarySyncStartRequest);
  if (!parsed.ok) return parsed.response;

  try {
    return json(await startSync(libraryDeps(), auth.server.id, parsed.data));
  } catch (err) {
    return libraryProblem(err);
  }
}
