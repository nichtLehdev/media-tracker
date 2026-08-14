import { db, eq, newId, schema } from '@media-tracker/db';

export interface DiscordIdentity {
  discordId: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Sign-in is the only way a users row is created (S15: no public signup).
 * Display name and avatar are refreshed each login so a rename in Discord
 * propagates without a separate sync.
 */
export async function upsertUserFromDiscord(
  identity: DiscordIdentity,
): Promise<string> {
  const [row] = await db()
    .insert(schema.users)
    .values({
      id: newId(),
      discordId: identity.discordId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
    })
    .onConflictDoUpdate({
      target: schema.users.discordId,
      set: {
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
      },
    })
    .returning({ id: schema.users.id });

  return row!.id;
}

export async function findUserById(id: string) {
  const [row] = await db()
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return row ?? null;
}
