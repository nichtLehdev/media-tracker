import { redirect } from 'next/navigation';
import { db, desc, eq, schema } from '@media-tracker/db';
import { auth } from '@/auth';
import { listServerAccounts } from '@/server/linking';
import { InviteButton, RegistrationCodePanel } from './panels';
import { revokeServerAction, unlinkAccountAction } from './actions';

export const dynamic = 'force-dynamic';

const LINK_LABEL: Record<string, string> = {
  unlinked: 'not linked',
  pending: 'invite sent',
  linked: 'linked',
  rejected: 'rejected',
};

export default async function ServersPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/signin?callbackUrl=/settings/servers');

  const servers = await db()
    .select()
    .from(schema.servers)
    .where(eq(schema.servers.ownerUserId, session.user.id))
    .orderBy(desc(schema.servers.createdAt));

  const withAccounts = await Promise.all(
    servers.map(async (server) => ({
      server,
      accounts: await listServerAccounts(server.id),
    })),
  );

  return (
    <main>
      <h1>Servers</h1>
      <p className="lede">
        Jellyfin servers you operate, and the accounts on them that are linked
        to tracker members.
      </p>

      <RegistrationCodePanel />

      {withAccounts.length === 0 ? (
        <div className="panel">
          <p className="empty">
            No servers registered yet. Generate a code above and complete
            registration from the plugin.
          </p>
        </div>
      ) : null}

      {withAccounts.map(({ server, accounts }) => (
        <div className="panel" key={server.id}>
          <h3>
            {server.name}{' '}
            {server.revokedAt ? (
              <span className="badge rejected">revoked</span>
            ) : null}
          </h3>
          <p className="meta">
            {server.jellyfinVersion
              ? `Jellyfin ${server.jellyfinVersion}`
              : 'Jellyfin version unknown'}
            {' · '}
            {server.pluginVersion
              ? `plugin ${server.pluginVersion}`
              : 'plugin version unknown'}
            {' · '}
            {server.lastSeenAt
              ? `last seen ${server.lastSeenAt.toLocaleString()}`
              : 'never connected'}
          </p>

          {accounts.length === 0 ? (
            <p className="empty">
              The plugin has not reported any Jellyfin accounts yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Jellyfin account</th>
                  <th>Status</th>
                  <th>Member</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.jellyfinUserId}>
                    <td>
                      {account.jellyfinUsername ?? (
                        <span className="mono">{account.jellyfinUserId}</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${account.linkState}`}>
                        {LINK_LABEL[account.linkState] ?? account.linkState}
                      </span>
                    </td>
                    <td>{account.linkedDisplayName ?? '—'}</td>
                    <td>
                      {account.linkState === 'linked' ? (
                        <form action={unlinkAccountAction}>
                          <input
                            type="hidden"
                            name="serverId"
                            value={server.id}
                          />
                          <input
                            type="hidden"
                            name="jellyfinUserId"
                            value={account.jellyfinUserId}
                          />
                          <button className="danger" type="submit">
                            Unlink
                          </button>
                        </form>
                      ) : (
                        <InviteButton
                          serverId={server.id}
                          jellyfinUserId={account.jellyfinUserId}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!server.revokedAt ? (
            <form action={revokeServerAction} style={{ marginTop: 16 }}>
              <input type="hidden" name="serverId" value={server.id} />
              <button className="danger" type="submit">
                Revoke server token
              </button>
            </form>
          ) : null}
        </div>
      ))}
    </main>
  );
}
