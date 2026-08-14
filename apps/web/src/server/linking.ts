import { and, db, eq, schema, sql } from '@media-tracker/db';
import type { LinkState } from '@media-tracker/contracts';
import { env } from '@/env';
import { createInviteToken, readInviteToken } from './secrets';

export interface ReportedAccount {
  jellyfin_user_id: string;
  jellyfin_username?: string | null | undefined;
}

export interface ServerAccountView {
  jellyfinUserId: string;
  jellyfinUsername: string | null;
  linkState: LinkState;
  linkedUserId: string | null;
  linkedDisplayName: string | null;
}

/**
 * The plugin reports the Jellyfin accounts on its server. This is a report,
 * never an assertion of identity (C2): the conflict clause deliberately
 * touches only the username, so a server cannot advance or reset a link by
 * re-reporting. Only the member accepting an invite moves link_state.
 */
export async function reportAccounts(
  serverId: string,
  accounts: ReportedAccount[],
): Promise<void> {
  if (accounts.length === 0) return;

  await db()
    .insert(schema.serverAccounts)
    .values(
      accounts.map((a) => ({
        serverId,
        jellyfinUserId: a.jellyfin_user_id,
        jellyfinUsername: a.jellyfin_username ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.serverAccounts.serverId,
        schema.serverAccounts.jellyfinUserId,
      ],
      set: {
        // Keep a previously reported username if this report omits it.
        jellyfinUsername: sql`coalesce(excluded.jellyfin_username, ${schema.serverAccounts.jellyfinUsername})`,
      },
    });
}

export async function listServerAccounts(
  serverId: string,
): Promise<ServerAccountView[]> {
  const rows = await db()
    .select({
      jellyfinUserId: schema.serverAccounts.jellyfinUserId,
      jellyfinUsername: schema.serverAccounts.jellyfinUsername,
      linkState: schema.serverAccounts.linkState,
      linkedUserId: schema.serverAccounts.userId,
      linkedDisplayName: schema.users.displayName,
    })
    .from(schema.serverAccounts)
    .leftJoin(schema.users, eq(schema.users.id, schema.serverAccounts.userId))
    .where(eq(schema.serverAccounts.serverId, serverId))
    .orderBy(schema.serverAccounts.jellyfinUsername);

  return rows.map((r) => ({
    ...r,
    linkState: r.linkState as LinkState,
  }));
}

export class LinkingError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}

/**
 * S8 step 2. Creates the pending row and returns a URL the owner sends to the
 * member over Discord.
 */
export async function createInvite(
  serverId: string,
  jellyfinUserId: string,
): Promise<{ url: string; expiresAt: Date }> {
  const [existing] = await db()
    .select({ linkState: schema.serverAccounts.linkState })
    .from(schema.serverAccounts)
    .where(
      and(
        eq(schema.serverAccounts.serverId, serverId),
        eq(schema.serverAccounts.jellyfinUserId, jellyfinUserId),
      ),
    )
    .limit(1);

  if (existing?.linkState === 'linked') {
    throw new LinkingError('already_linked');
  }

  await db()
    .insert(schema.serverAccounts)
    .values({ serverId, jellyfinUserId, linkState: 'pending' })
    .onConflictDoUpdate({
      target: [
        schema.serverAccounts.serverId,
        schema.serverAccounts.jellyfinUserId,
      ],
      set: { linkState: 'pending' },
    });

  const { token, expiresAt } = createInviteToken(serverId, jellyfinUserId);
  return {
    url: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/link/${token}`,
    expiresAt,
  };
}

export interface InvitePreview {
  serverId: string;
  serverName: string;
  jellyfinUserId: string;
  jellyfinUsername: string | null;
  linkState: LinkState;
  linkedUserId: string | null;
}

export async function readInvite(token: string): Promise<InvitePreview> {
  const decoded = readInviteToken(token);
  if (!decoded) throw new LinkingError('invalid_or_expired_invite');

  const [row] = await db()
    .select({
      serverId: schema.servers.id,
      serverName: schema.servers.name,
      revokedAt: schema.servers.revokedAt,
      jellyfinUserId: schema.serverAccounts.jellyfinUserId,
      jellyfinUsername: schema.serverAccounts.jellyfinUsername,
      linkState: schema.serverAccounts.linkState,
      linkedUserId: schema.serverAccounts.userId,
    })
    .from(schema.serverAccounts)
    .innerJoin(
      schema.servers,
      eq(schema.servers.id, schema.serverAccounts.serverId),
    )
    .where(
      and(
        eq(schema.serverAccounts.serverId, decoded.serverId),
        eq(schema.serverAccounts.jellyfinUserId, decoded.jellyfinUserId),
      ),
    )
    .limit(1);

  if (!row) throw new LinkingError('invalid_or_expired_invite');
  if (row.revokedAt) throw new LinkingError('server_revoked');

  return {
    serverId: row.serverId,
    serverName: row.serverName,
    jellyfinUserId: row.jellyfinUserId,
    jellyfinUsername: row.jellyfinUsername,
    linkState: row.linkState as LinkState,
    linkedUserId: row.linkedUserId,
  };
}

/** S8 steps 4-5. The member's half of the two-sided consent. */
export async function acceptInvite(
  token: string,
  userId: string,
): Promise<InvitePreview> {
  const preview = await readInvite(token);

  if (preview.linkState === 'linked') {
    // Idempotent for the same member; a conflict for anyone else.
    if (preview.linkedUserId === userId) return preview;
    throw new LinkingError('claimed_by_another_member');
  }

  const updated = await db()
    .update(schema.serverAccounts)
    .set({ linkState: 'linked', userId, linkedAt: new Date() })
    .where(
      and(
        eq(schema.serverAccounts.serverId, preview.serverId),
        eq(schema.serverAccounts.jellyfinUserId, preview.jellyfinUserId),
        // Re-checked in the UPDATE so two members racing one invite cannot
        // both win.
        eq(schema.serverAccounts.linkState, preview.linkState),
      ),
    )
    .returning({ jellyfinUserId: schema.serverAccounts.jellyfinUserId });

  if (updated.length === 0) throw new LinkingError('claimed_by_another_member');

  return { ...preview, linkState: 'linked', linkedUserId: userId };
}

export async function declineInvite(token: string): Promise<void> {
  const preview = await readInvite(token);
  if (preview.linkState === 'linked') throw new LinkingError('already_linked');

  await db()
    .update(schema.serverAccounts)
    .set({ linkState: 'rejected' })
    .where(
      and(
        eq(schema.serverAccounts.serverId, preview.serverId),
        eq(schema.serverAccounts.jellyfinUserId, preview.jellyfinUserId),
      ),
    );
}

/**
 * S8: unlinking stops future ingest but never deletes historical
 * watch_events. Deleting data is a separate, explicit action.
 */
export async function unlinkAccount(
  serverId: string,
  jellyfinUserId: string,
): Promise<void> {
  await db()
    .update(schema.serverAccounts)
    .set({ linkState: 'rejected', userId: null, linkedAt: null })
    .where(
      and(
        eq(schema.serverAccounts.serverId, serverId),
        eq(schema.serverAccounts.jellyfinUserId, jellyfinUserId),
      ),
    );
}
