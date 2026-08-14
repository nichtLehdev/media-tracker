import type { PgBoss } from 'pg-boss';
import { db as sharedDb, lte, inArray, schema, type Database } from '@media-tracker/db';

/**
 * S5.3. Sessions carry a two-minute TTL that every heartbeat extends. Nothing
 * else cleans them up: a member's server dropping offline mid-episode never
 * sends a stop event, so without this job the session sits in "now playing"
 * forever.
 *
 * Expiry archives before it deletes (S19 open question 5). See
 * `playback_session_archive` for why that decision could not be deferred.
 */

export const SESSION_EXPIRY_QUEUE = 'session-expiry';

/** Bounded so one drain cannot hold a long transaction over a large backlog. */
const BATCH_SIZE = 500;

/**
 * Drains sessions whose TTL has run out, archiving a summary row for each.
 * Returns how many were drained.
 */
export async function expireSessions(
  database: Database,
  now = new Date(),
): Promise<number> {
  const sessions = schema.playbackSessions;
  const archive = schema.playbackSessionArchive;

  let drained = 0;

  for (;;) {
    const batch = await database.transaction(async (tx) => {
      const expired = await tx
        .select()
        .from(sessions)
        .where(lte(sessions.expiresAt, now))
        .limit(BATCH_SIZE);

      if (expired.length === 0) return 0;

      // The session's own id becomes the archive id, so a replayed drain
      // conflicts with itself instead of counting a session twice.
      await tx
        .insert(archive)
        .values(
          expired.map((s) => ({
            id: s.id,
            userId: s.userId,
            serverId: s.serverId,
            mediaItemId: s.mediaItemId,
            episodeId: s.episodeId,
            device: s.device,
            startedAt: s.startedAt,
            // The last heartbeat, not expiresAt: the TTL is slack, and
            // counting it would inflate every session by two minutes.
            endedAt: s.updatedAt,
            positionSec: s.positionSec,
            runtimeSec: s.runtimeSec,
            archivedAt: now,
          })),
        )
        .onConflictDoNothing({ target: archive.id });

      await tx.delete(sessions).where(
        inArray(
          sessions.id,
          expired.map((s) => s.id),
        ),
      );

      return expired.length;
    });

    drained += batch;
    if (batch < BATCH_SIZE) break;
  }

  return drained;
}

/**
 * Runs every minute. The TTL is two minutes, so a session is visible as "now
 * playing" for at most three after its server goes quiet.
 */
export async function registerSessionExpiry(
  boss: PgBoss,
  database: Database = sharedDb(),
): Promise<void> {
  await boss.createQueue(SESSION_EXPIRY_QUEUE, {
    // Nothing reads these job records; keep the queue table small.
    retentionSeconds: 60 * 60,
    // A drain that outlives the next tick is stuck, not slow.
    expireInSeconds: 55,
  });

  await boss.work(SESSION_EXPIRY_QUEUE, async () => {
    const drained = await expireSessions(database);
    if (drained > 0) console.log(`[worker] expired ${drained} playback session(s)`);
  });

  await boss.schedule(SESSION_EXPIRY_QUEUE, '* * * * *');
}
