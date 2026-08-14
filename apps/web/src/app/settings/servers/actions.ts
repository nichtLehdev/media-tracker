'use server';

import { revalidatePath } from 'next/cache';
import { and, db, eq, newId, schema } from '@media-tracker/db';
import { auth } from '@/auth';
import {
  createInvite,
  LinkingError,
  unlinkAccount,
} from '@/server/linking';
import {
  generateRegistrationCode,
  hashRegistrationCode,
} from '@/server/secrets';

const CODE_TTL_MS = 15 * 60 * 1000;

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error('not_authenticated');
  return session.user.id;
}

/** Every mutation below is scoped to a server the acting user actually owns. */
async function requireOwnedServer(
  serverId: string,
  userId: string,
): Promise<void> {
  const [row] = await db()
    .select({ id: schema.servers.id })
    .from(schema.servers)
    .where(
      and(
        eq(schema.servers.id, serverId),
        eq(schema.servers.ownerUserId, userId),
      ),
    )
    .limit(1);
  if (!row) throw new Error('not_found');
}

export interface CodeState {
  code?: string;
  expiresAt?: string;
  error?: string;
}

/** S6.1: single-use, 15 minutes, shown once. */
export async function createRegistrationCodeAction(): Promise<CodeState> {
  const userId = await requireUserId();

  const code = generateRegistrationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await db().insert(schema.registrationCodes).values({
    id: newId(),
    codeHash: hashRegistrationCode(code),
    ownerUserId: userId,
    expiresAt,
  });

  return { code, expiresAt: expiresAt.toISOString() };
}

export interface InviteState {
  url?: string;
  jellyfinUserId?: string;
  error?: string;
}

export async function createInviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const userId = await requireUserId();
  const serverId = String(formData.get('serverId') ?? '');
  const jellyfinUserId = String(formData.get('jellyfinUserId') ?? '');

  try {
    await requireOwnedServer(serverId, userId);
    const invite = await createInvite(serverId, jellyfinUserId);
    revalidatePath('/settings/servers');
    return { url: invite.url, jellyfinUserId };
  } catch (err) {
    if (err instanceof LinkingError) {
      return { error: err.code, jellyfinUserId };
    }
    return { error: 'invite_failed', jellyfinUserId };
  }
}

export async function unlinkAccountAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const serverId = String(formData.get('serverId') ?? '');
  const jellyfinUserId = String(formData.get('jellyfinUserId') ?? '');

  await requireOwnedServer(serverId, userId);
  await unlinkAccount(serverId, jellyfinUserId);
  revalidatePath('/settings/servers');
}

/**
 * Revoking makes the server's bearer token stop authenticating. It does not
 * delete anything the server already contributed -- S8 keeps that a separate,
 * explicit action.
 */
export async function revokeServerAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const serverId = String(formData.get('serverId') ?? '');

  await requireOwnedServer(serverId, userId);
  await db()
    .update(schema.servers)
    .set({ revokedAt: new Date() })
    .where(eq(schema.servers.id, serverId));
  revalidatePath('/settings/servers');
}
