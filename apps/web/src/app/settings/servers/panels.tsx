'use client';

import { useActionState, useState } from 'react';
import {
  createInviteAction,
  createRegistrationCodeAction,
  type CodeState,
  type InviteState,
} from './actions';

export function RegistrationCodePanel() {
  const [state, action, pending] = useActionState<CodeState>(
    async () => createRegistrationCodeAction(),
    {},
  );

  return (
    <div className="panel">
      <h3>Add a server</h3>
      <p className="meta">
        Generate a code, then paste it into the Tracker plugin&apos;s
        configuration page in Jellyfin. Codes are single-use and expire after
        15 minutes.
      </p>

      <form action={action}>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Generating…' : 'Generate registration code'}
        </button>
      </form>

      {state.code ? (
        <>
          <code className="code-block code-big">{state.code}</code>
          <p className="meta" style={{ margin: 0 }}>
            Expires{' '}
            {state.expiresAt
              ? new Date(state.expiresAt).toLocaleTimeString()
              : 'shortly'}
            . It will not be shown again.
          </p>
        </>
      ) : null}
      {state.error ? <div className="notice error">{state.error}</div> : null}
    </div>
  );
}

export function InviteButton({
  serverId,
  jellyfinUserId,
}: {
  serverId: string;
  jellyfinUserId: string;
}) {
  const [state, action, pending] = useActionState<InviteState, FormData>(
    createInviteAction,
    {},
  );
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="serverId" value={serverId} />
        <input type="hidden" name="jellyfinUserId" value={jellyfinUserId} />
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Invite'}
        </button>
      </form>

      {state.url ? (
        <>
          <code className="code-block">{state.url}</code>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(state.url!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <span className="meta" style={{ margin: 0 }}>
              Send this to the member on Discord.
            </span>
          </div>
        </>
      ) : null}
      {state.error ? <div className="notice error">{state.error}</div> : null}
    </div>
  );
}
