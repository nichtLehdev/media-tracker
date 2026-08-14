import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { LinkingError, readInvite } from '@/server/linking';
import { ConsentForm } from './consent';

export const dynamic = 'force-dynamic';

/**
 * S8 step 4. The member's half of the two-sided consent: the owner asserts a
 * mapping, and nothing is attributed until the member confirms it here.
 */
export default async function LinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/signin?callbackUrl=/link/${encodeURIComponent(token)}`);
  }

  let invite;
  try {
    invite = await readInvite(token);
  } catch (err) {
    return (
      <main>
        <h1>Link a Jellyfin account</h1>
        <div className="notice error">
          {err instanceof LinkingError && err.code === 'server_revoked'
            ? 'That server’s access has been revoked.'
            : 'This invite is invalid or has expired. Ask the server owner for a new one.'}
        </div>
      </main>
    );
  }

  const displayName = invite.jellyfinUsername ?? invite.jellyfinUserId;

  if (invite.linkState === 'linked' && invite.linkedUserId !== session.user.id) {
    return (
      <main>
        <h1>Link a Jellyfin account</h1>
        <div className="notice error">
          <strong>{displayName}</strong> on <strong>{invite.serverName}</strong>{' '}
          is already linked to a different member.
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Link a Jellyfin account</h1>
      <p className="lede">
        <strong>{invite.serverName}</strong> claims you are the Jellyfin user{' '}
        <strong>{displayName}</strong>.
      </p>

      <div className="panel">
        <p className="meta">
          Accepting lets that server report your watches to the tracker. The
          server&apos;s owner can see what you watch there, and can attribute
          watches to you — only accept invites from servers you actually use.
        </p>
        <ConsentForm
          token={token}
          serverName={invite.serverName}
          jellyfinUsername={displayName}
        />
      </div>
    </main>
  );
}
