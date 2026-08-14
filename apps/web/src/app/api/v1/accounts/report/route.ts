import {
  accountsReportRequest,
  type AccountsReportResponse,
} from '@media-tracker/contracts';
import { json, parseBody } from '@/server/api';
import {
  authenticateServer,
  recordServerHeartbeat,
} from '@/server/plugin-auth';
import { listServerAccounts, reportAccounts } from '@/server/linking';

export const dynamic = 'force-dynamic';

/**
 * The plugin reports its local Jellyfin accounts and gets their link states
 * back to render in its config page (S7.5). Reporting never changes a link
 * state -- only the member accepting an invite does that (S8).
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateServer(req);
  if (!auth.ok) return auth.response;
  await recordServerHeartbeat(auth.server.id, req);

  const parsed = await parseBody(req, accountsReportRequest);
  if (!parsed.ok) return parsed.response;

  await reportAccounts(auth.server.id, parsed.data.accounts);

  const accounts = await listServerAccounts(auth.server.id);
  const response: AccountsReportResponse = {
    accounts: accounts.map((a) => ({
      jellyfin_user_id: a.jellyfinUserId,
      jellyfin_username: a.jellyfinUsername,
      link_state: a.linkState,
      linked_display_name: a.linkedDisplayName,
    })),
  };
  return json(response);
}
