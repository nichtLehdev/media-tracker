'use client';

import { useActionState } from 'react';
import {
  acceptInviteAction,
  declineInviteAction,
  type LinkResult,
} from './actions';

const ERRORS: Record<string, string> = {
  invalid_or_expired_invite:
    'This invite is no longer valid. Ask the server owner for a new one.',
  claimed_by_another_member:
    'This Jellyfin account is already linked to a different member.',
  already_linked: 'This account is already linked.',
  server_revoked: 'That server’s access has been revoked.',
};

export function ConsentForm({
  token,
  serverName,
  jellyfinUsername,
}: {
  token: string;
  serverName: string;
  jellyfinUsername: string;
}) {
  const [accepted, accept, accepting] = useActionState<LinkResult, FormData>(
    acceptInviteAction,
    { status: 'idle' },
  );
  const [declined, decline, declining] = useActionState<LinkResult, FormData>(
    declineInviteAction,
    { status: 'idle' },
  );

  const result = accepted.status !== 'idle' ? accepted : declined;

  if (result.status === 'linked') {
    return (
      <div className="notice ok">
        Linked. Watches from <strong>{jellyfinUsername}</strong> on{' '}
        <strong>{serverName}</strong> will now be tracked against your account.
      </div>
    );
  }

  if (result.status === 'declined') {
    return (
      <div className="notice">
        Declined. Nothing from that account will be attributed to you.
      </div>
    );
  }

  return (
    <>
      {result.status === 'error' && result.error ? (
        <div className="notice error">
          {ERRORS[result.error] ?? 'Something went wrong linking that account.'}
        </div>
      ) : null}

      <div className="row">
        <form action={accept}>
          <input type="hidden" name="token" value={token} />
          <button className="primary" type="submit" disabled={accepting}>
            {accepting ? 'Linking…' : 'Yes, that’s me'}
          </button>
        </form>
        <form action={decline}>
          <input type="hidden" name="token" value={token} />
          <button type="submit" disabled={declining}>
            {declining ? 'Declining…' : 'No, decline'}
          </button>
        </form>
      </div>
    </>
  );
}
