import { createDatabase } from './client.js';
import { newId } from './ids.js';
import * as schema from './schema/index.js';

/**
 * Creates a development member. Sign-in normally creates users (S15: no public
 * signup), so local work without live Discord credentials needs this.
 */
async function main(): Promise<void> {
  const db = createDatabase({ max: 1 });

  const discordId = process.env.SEED_DISCORD_ID ?? '100000000000000001';
  const displayName = process.env.SEED_DISPLAY_NAME ?? 'Dev Member';

  const [user] = await db
    .insert(schema.users)
    .values({ id: newId(), discordId, displayName, avatarUrl: null })
    .onConflictDoUpdate({
      target: schema.users.discordId,
      set: { displayName },
    })
    .returning({ id: schema.users.id, displayName: schema.users.displayName });

  console.log(`seeded user ${user!.displayName} (${user!.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
