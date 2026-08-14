import {
  accountInviteRequest,
  type AccountInviteResponse,
} from '@media-tracker/contracts';
import { json, parseBody, problem } from '@/server/api';
import {
  authenticateServer,
  recordServerHeartbeat,
} from '@/server/plugin-auth';
import { createInvite, LinkingError } from '@/server/linking';

export const dynamic = 'force-dynamic';

/**
 * S8 step 2, issued from the plugin's config page. The owner then sends the
 * returned URL to the member over Discord; the member's acceptance is the
 * other half of the consent.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateServer(req);
  if (!auth.ok) return auth.response;
  await recordServerHeartbeat(auth.server.id, req);

  const parsed = await parseBody(req, accountInviteRequest);
  if (!parsed.ok) return parsed.response;

  try {
    const invite = await createInvite(
      auth.server.id,
      parsed.data.jellyfin_user_id,
    );
    const response: AccountInviteResponse = {
      invite_url: invite.url,
      expires_at: invite.expiresAt.toISOString(),
    };
    return json(response);
  } catch (err) {
    if (err instanceof LinkingError) return problem(409, err.code);
    throw err;
  }
}
