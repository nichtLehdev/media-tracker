import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, newId, schema, type Database } from '@media-tracker/db';
import {
  createTestDatabase,
  hasTestDatabase,
  type TestDatabase,
} from '@media-tracker/db/testing';
import { expireSessions } from './session-expiry.js';

/**
 * S5.3: sessions are upserted on every heartbeat with a two-minute TTL, and a
 * periodic job drains the expired ones. That job -- not a stop event -- is what
 * cleans up when a member's server drops offline mid-episode.
 *
 * S19 open question 5 is answered here: expiry archives a summary row before
 * deleting, so watch-time stats remain possible later.
 */

const MINUTE = 60 * 1000;
const T0 = new Date('2026-08-15T20:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

describe.skipIf(!hasTestDatabase())('expireSessions (S5.3)', () => {
  let harness: TestDatabase;
  let db: Database;
  let userId: string;
  let serverId: string;
  let mediaItemId: string;

  beforeAll(async () => {
    harness = await createTestDatabase();
    db = harness.db;
  });

  afterAll(async () => {
    await harness?.drop();
  });

  beforeEach(async () => {
    await harness.sql`
      TRUNCATE playback_session_archive, playback_sessions, media_items,
               servers, users RESTART IDENTITY CASCADE`;

    userId = newId();
    serverId = newId();
    mediaItemId = newId();

    await db.insert(schema.users).values({
      id: userId,
      discordId: '100000000000000001',
      displayName: 'Anna',
    });
    await db.insert(schema.servers).values({
      id: serverId,
      ownerUserId: userId,
      name: 'LarsFlix',
      secretHash: 'argon2id$not-a-real-hash',
    });
    await db.insert(schema.mediaItems).values({
      id: mediaItemId,
      kind: 'show',
      tmdbId: 83867,
      title: 'Andor',
    });
  });

  async function seedSession(opts: {
    id?: string;
    startedAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    positionSec?: number;
  }): Promise<string> {
    const id = opts.id ?? newId();
    await db.insert(schema.playbackSessions).values({
      id,
      userId,
      serverId,
      jellyfinSessionId: `jf-session-${id}`,
      mediaItemId,
      positionSec: opts.positionSec ?? 812,
      runtimeSec: 2610,
      device: 'webOS',
      startedAt: opts.startedAt,
      updatedAt: opts.updatedAt,
      expiresAt: opts.expiresAt,
    });
    return id;
  }

  const liveSessions = async () => await db.select().from(schema.playbackSessions);
  const archived = async () =>
    await db.select().from(schema.playbackSessionArchive);

  it('leaves a session that is still alive', async () => {
    await seedSession({
      startedAt: T0,
      updatedAt: at(10),
      expiresAt: at(12), // TTL has not run out at at(11)
    });

    const drained = await expireSessions(db, at(11));

    expect(drained).toBe(0);
    expect(await liveSessions()).toHaveLength(1);
    expect(await archived()).toHaveLength(0);
  });

  it('archives and deletes a session past its TTL', async () => {
    const id = await seedSession({
      startedAt: T0,
      updatedAt: at(45),
      expiresAt: at(47),
      positionSec: 2400,
    });

    const drained = await expireSessions(db, at(48));

    expect(drained).toBe(1);
    expect(await liveSessions()).toHaveLength(0);

    const rows = await archived();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(id);
    expect(row.userId).toBe(userId);
    expect(row.serverId).toBe(serverId);
    expect(row.mediaItemId).toBe(mediaItemId);
    expect(row.device).toBe('webOS');
    expect(row.positionSec).toBe(2400);
    expect(row.runtimeSec).toBe(2610);
    expect(row.startedAt.toISOString()).toBe(T0.toISOString());
    // ended_at is the last heartbeat, not expires_at: the TTL is slack, and
    // counting it would inflate every session by two minutes.
    expect(row.endedAt.toISOString()).toBe(at(45).toISOString());
  });

  it('expires exactly at the TTL boundary', async () => {
    await seedSession({ startedAt: T0, updatedAt: at(10), expiresAt: at(12) });

    expect(await expireSessions(db, at(12))).toBe(1);
    expect(await liveSessions()).toHaveLength(0);
  });

  it('drains several sessions at once and leaves live ones alone', async () => {
    await seedSession({ startedAt: T0, updatedAt: at(5), expiresAt: at(7) });
    await seedSession({ startedAt: T0, updatedAt: at(6), expiresAt: at(8) });
    await seedSession({ startedAt: T0, updatedAt: at(30), expiresAt: at(32) });

    const drained = await expireSessions(db, at(20));

    expect(drained).toBe(2);
    expect(await liveSessions()).toHaveLength(1);
    expect(await archived()).toHaveLength(2);
  });

  it('is idempotent: re-archiving the same session id does not double count', async () => {
    const id = newId();
    await seedSession({
      id,
      startedAt: T0,
      updatedAt: at(10),
      expiresAt: at(12),
    });
    await expireSessions(db, at(13));

    // The member starts watching again and that session also expires. Reusing
    // the id is not something Jellyfin does, but the archive must not be the
    // thing that breaks if a retry replays a drain.
    await seedSession({
      id,
      startedAt: at(20),
      updatedAt: at(30),
      expiresAt: at(32),
    });
    const drained = await expireSessions(db, at(40));

    expect(drained).toBe(1);
    expect(await archived()).toHaveLength(1);
    expect(await liveSessions()).toHaveLength(0);
  });

  it('does nothing when there is nothing to expire', async () => {
    expect(await expireSessions(db, at(5))).toBe(0);
    expect(await archived()).toHaveLength(0);
  });

  it('archives an episode session with its episode id', async () => {
    const episodeId = newId();
    await db.insert(schema.episodes).values({
      id: episodeId,
      showId: mediaItemId,
      season: 1,
      number: 3,
      title: 'Reckoning',
    });
    const id = newId();
    await db.insert(schema.playbackSessions).values({
      id,
      userId,
      serverId,
      jellyfinSessionId: 'jf-ep',
      mediaItemId,
      episodeId,
      positionSec: 500,
      runtimeSec: 2610,
      startedAt: T0,
      updatedAt: at(10),
      expiresAt: at(12),
    });

    await expireSessions(db, at(13));

    const rows = await archived();
    expect(rows[0]!.episodeId).toBe(episodeId);
  });

  it('does not archive a session whose server was deleted first', async () => {
    // playback_sessions cascades on server delete; the archive does not, so a
    // race between deletion and the drain must not resurrect a foreign key.
    await seedSession({ startedAt: T0, updatedAt: at(5), expiresAt: at(7) });
    await db.delete(schema.servers).where(eq(schema.servers.id, serverId));

    expect(await expireSessions(db, at(10))).toBe(0);
    expect(await archived()).toHaveLength(0);
  });
});
