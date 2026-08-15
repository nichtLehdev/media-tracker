import { librarySyncChunkRequest } from '@media-tracker/contracts';
import { json, parseBody } from '@/server/api';
import { authenticateServer, recordServerHeartbeat } from '@/server/plugin-auth';
import { applySyncChunk } from '@/server/library';
import { libraryDeps, libraryProblem } from '@/server/library-route';

export const dynamic = 'force-dynamic';

/** S6.3.2. Up to 500 items per chunk. */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateServer(req);
  if (!auth.ok) return auth.response;
  await recordServerHeartbeat(auth.server.id, req);

  const parsed = await parseBody(req, librarySyncChunkRequest);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await applySyncChunk(libraryDeps(), auth.server.id, parsed.data);
    return json(result, { status: 202 });
  } catch (err) {
    return libraryProblem(err);
  }
}
