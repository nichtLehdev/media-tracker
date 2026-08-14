import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, db, eq, schema } from '@media-tracker/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

/**
 * M1 placeholder. The real dashboard (now playing, recent activity, upcoming
 * screenings) lands in M4 once there is data to show.
 */
export default async function HomePage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/signin');

  const linked = await db()
    .select({
      serverName: schema.servers.name,
      jellyfinUsername: schema.serverAccounts.jellyfinUsername,
    })
    .from(schema.serverAccounts)
    .innerJoin(
      schema.servers,
      eq(schema.servers.id, schema.serverAccounts.serverId),
    )
    .where(
      and(
        eq(schema.serverAccounts.userId, session.user.id),
        eq(schema.serverAccounts.linkState, 'linked'),
      ),
    );

  return (
    <main>
      <h1>Dashboard</h1>
      <p className="lede">
        Now playing, recent activity and upcoming screenings arrive in a later
        milestone. For now, this shows which Jellyfin accounts are linked to
        you.
      </p>

      <div className="panel">
        <h3>Your linked Jellyfin accounts</h3>
        {linked.length === 0 ? (
          <p className="empty">
            None yet. A server owner sends you an invite link, or you{' '}
            <Link href="/settings/servers">register your own server</Link>.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th>Jellyfin account</th>
              </tr>
            </thead>
            <tbody>
              {linked.map((row) => (
                <tr key={`${row.serverName}:${row.jellyfinUsername}`}>
                  <td>{row.serverName}</td>
                  <td>{row.jellyfinUsername ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
