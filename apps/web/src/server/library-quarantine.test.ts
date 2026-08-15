import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, newId, schema, type Database } from '@media-tracker/db';
import {
  createTestDatabase,
  hasTestDatabase,
  type TestDatabase,
} from '@media-tracker/db/testing';
import {
  applyRemovals,
  exceedsRemovalThreshold,
  fingerprintEntryIds,
  removalThreshold,
} from './library-quarantine';

/**
 * S7.6, the mass-removal safety valve.
 *
 * S18 (M2) requires this file to exist before the delete path does: the
 * failure it guards -- a dropped network mount making Jellyfin report
 * thousands of deletions -- is silent, and destroys a member's library.
 */

describe('removal threshold (S7.6)', () => {
  // "more than 10% of entries, or more than 200 entries, whichever is lower"
  it('is ten percent of the library below 2000 entries', () => {
    expect(removalThreshold(1000)).toBe(100);
    expect(removalThreshold(100)).toBe(10);
  });

  it('caps at 200 once ten percent would exceed it', () => {
    expect(removalThreshold(2000)).toBe(200);
    expect(removalThreshold(4000)).toBe(200);
    expect(removalThreshold(20_000)).toBe(200);
  });

  it('is exclusive: removing exactly the threshold is allowed', () => {
    expect(exceedsRemovalThreshold(1000, 100)).toBe(false);
    expect(exceedsRemovalThreshold(1000, 101)).toBe(true);
    expect(exceedsRemovalThreshold(4000, 200)).toBe(false);
    expect(exceedsRemovalThreshold(4000, 201)).toBe(true);
  });

  // A pure 10% rule flags a member deleting four films from a 30-entry
  // library. The floor exists so the notice stays rare enough that an owner
  // reads it instead of reflexively pressing Apply.
  it('floors at 5, so routine tidying of a small library is not flagged', () => {
    expect(removalThreshold(10)).toBe(5);
    expect(removalThreshold(30)).toBe(5);
    expect(removalThreshold(0)).toBe(5);
    expect(exceedsRemovalThreshold(30, 5)).toBe(false);
    expect(exceedsRemovalThreshold(30, 6)).toBe(true);
  });

  it('still catches a wipe of a small library', () => {
    // 30 entries, all of them gone: over the floor, so it is held.
    expect(exceedsRemovalThreshold(30, 30)).toBe(true);
  });

  it('never fires on an empty removal set', () => {
    expect(exceedsRemovalThreshold(0, 0)).toBe(false);
    expect(exceedsRemovalThreshold(5000, 0)).toBe(false);
  });
});

describe('fingerprint (S7.6)', () => {
  it('ignores the order the ids arrive in', () => {
    const a = ['b', 'a', 'c'];
    const b = ['c', 'b', 'a'];
    expect(fingerprintEntryIds(a)).toBe(fingerprintEntryIds(b));
  });

  it('distinguishes different removal sets, so streaks cannot merge', () => {
    expect(fingerprintEntryIds(['a', 'b'])).not.toBe(
      fingerprintEntryIds(['a', 'c']),
    );
    expect(fingerprintEntryIds(['a', 'b'])).not.toBe(
      fingerprintEntryIds(['a', 'b', 'c']),
    );
  });
});

// --- integration -----------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-08-15T04:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

describe.skipIf(!hasTestDatabase())('applyRemovals (S7.6)', () => {
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
      TRUNCATE library_sync_quarantine, library_entries, media_items,
               server_accounts, servers, users RESTART IDENTITY CASCADE`;

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
      kind: 'movie',
      tmdbId: 330459,
      title: 'Rogue One',
    });
  });

  /**
   * Creates `count` library entries and returns their ids. Each needs its own
   * media item: library_entries_logical is unique per
   * (user, server, media, episode).
   */
  async function seedLibrary(count: number): Promise<string[]> {
    const media = Array.from({ length: count }, (_, i) => ({
      id: newId(),
      kind: 'movie' as const,
      tmdbId: 900_000 + i,
      title: `Film ${i}`,
    }));
    const rows = media.map((m, i) => ({
      id: newId(),
      userId,
      serverId,
      mediaItemId: m.id,
      jellyfinItemId: `jf-${i}`,
      lastConfirmedAt: T0,
    }));

    await db.insert(schema.mediaItems).values(media);
    await db.insert(schema.libraryEntries).values(rows);
    return rows.map((r) => r.id);
  }

  const countEntries = async () =>
    (
      await db
        .select()
        .from(schema.libraryEntries)
        .where(
          and(
            eq(schema.libraryEntries.userId, userId),
            eq(schema.libraryEntries.serverId, serverId),
          ),
        )
    ).length;

  const openQuarantine = async () =>
    await db
      .select()
      .from(schema.librarySyncQuarantine)
      .where(eq(schema.librarySyncQuarantine.serverId, serverId));

  it('applies a removal under the threshold', async () => {
    const ids = await seedLibrary(100);

    const outcome = await applyRemovals(db, {
      serverId,
      userId,
      entryIds: ids.slice(0, 10),
      source: 'delta',
      now: T0,
    });

    expect(outcome.quarantined).toBe(false);
    expect(outcome.removed).toBe(10);
    expect(await countEntries()).toBe(90);
    expect(await openQuarantine()).toHaveLength(0);
  });

  it('quarantines a removal over the threshold and deletes nothing', async () => {
    const ids = await seedLibrary(100);

    const outcome = await applyRemovals(db, {
      serverId,
      userId,
      entryIds: ids.slice(0, 11), // 11 > 10% of 100
      source: 'delta',
      now: T0,
    });

    expect(outcome.quarantined).toBe(true);
    expect(outcome.removed).toBe(0);
    expect(await countEntries()).toBe(100);

    const rows = await openQuarantine();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.entryCount).toBe(11);
    expect(row.libraryCount).toBe(100);
    expect(row.occurrences).toBe(1);
    expect(row.resolvedAt).toBeNull();
    expect(row.fingerprint).toBe(fingerprintEntryIds(ids.slice(0, 11)));
  });

  it('applies a small-library removal that sits under the floor', async () => {
    const ids = await seedLibrary(30);

    const outcome = await applyRemovals(db, {
      serverId, userId, entryIds: ids.slice(0, 5), source: 'delta', now: T0,
    });

    expect(outcome.quarantined).toBe(false);
    expect(await countEntries()).toBe(25);
  });

  it('still quarantines a small-library removal over the floor', async () => {
    const ids = await seedLibrary(30);

    const outcome = await applyRemovals(db, {
      serverId, userId, entryIds: ids.slice(0, 6), source: 'delta', now: T0,
    });

    expect(outcome.quarantined).toBe(true);
    expect(await countEntries()).toBe(30);
  });

  it('ignores entries belonging to another member on the same server', async () => {
    // The ownership filter here is the real boundary, not the one in the
    // caller: a delta for Anna resolves ids by (server, item) and must not be
    // able to reach Bob's rows on the same server (C2).
    const bobId = newId();
    await db.insert(schema.users).values({
      id: bobId,
      discordId: '100000000000000002',
      displayName: 'Bob',
    });
    const mine = await seedLibrary(100);
    const bobMedia = newId();
    const bobEntry = newId();
    await db.insert(schema.mediaItems).values({
      id: bobMedia,
      kind: 'movie',
      tmdbId: 700_001,
      title: "Bob's Film",
    });
    await db.insert(schema.libraryEntries).values({
      id: bobEntry,
      userId: bobId,
      serverId,
      mediaItemId: bobMedia,
      jellyfinItemId: 'jf-bob-1',
      lastConfirmedAt: T0,
    });

    const outcome = await applyRemovals(db, {
      serverId,
      userId,
      entryIds: [...mine.slice(0, 3), bobEntry],
      source: 'delta',
      now: T0,
    });

    expect(outcome.removed).toBe(3);
    const survivors = await db
      .select()
      .from(schema.libraryEntries)
      .where(eq(schema.libraryEntries.userId, bobId));
    expect(survivors).toHaveLength(1);
  });

  it('is a no-op for an empty removal set', async () => {
    await seedLibrary(10);

    const outcome = await applyRemovals(db, {
      serverId,
      userId,
      entryIds: [],
      source: 'snapshot',
      now: T0,
    });

    expect(outcome.quarantined).toBe(false);
    expect(outcome.removed).toBe(0);
    expect(await countEntries()).toBe(10);
    expect(await openQuarantine()).toHaveLength(0);
  });

  it('ignores ids that are not in the library, rather than counting them', async () => {
    const ids = await seedLibrary(100);
    // 5 real removals padded with 20 ids that are already gone. Counting the
    // strays would push this over the threshold and quarantine a batch that
    // only removes 5 entries.
    const strays = Array.from({ length: 20 }, () => newId());

    const outcome = await applyRemovals(db, {
      serverId,
      userId,
      entryIds: [...ids.slice(0, 5), ...strays],
      source: 'delta',
      now: T0,
    });

    expect(outcome.quarantined).toBe(false);
    expect(outcome.removed).toBe(5);
    expect(await countEntries()).toBe(95);
  });

  it('does not advance the streak when the same set repeats within 6 hours', async () => {
    const ids = await seedLibrary(100);
    const removal = ids.slice(0, 50);

    await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: T0,
    });
    const outcome = await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: at(5.9),
    });

    expect(outcome.quarantined).toBe(true);
    expect(outcome.occurrences).toBe(1);
    expect(await countEntries()).toBe(100);
    expect(await openQuarantine()).toHaveLength(1);
  });

  it('advances the streak on a snapshot at least 6 hours later', async () => {
    const ids = await seedLibrary(100);
    const removal = ids.slice(0, 50);

    await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: T0,
    });
    const outcome = await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: at(6),
    });

    expect(outcome.quarantined).toBe(true);
    expect(outcome.occurrences).toBe(2);
    expect(await countEntries()).toBe(100);
  });

  it('auto-releases on the third consecutive snapshot 6 hours apart', async () => {
    const ids = await seedLibrary(100);
    const removal = ids.slice(0, 50);

    await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: T0,
    });
    await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: at(6),
    });
    const outcome = await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: at(12),
    });

    expect(outcome.autoApplied).toBe(true);
    expect(outcome.quarantined).toBe(false);
    expect(outcome.removed).toBe(50);
    expect(await countEntries()).toBe(50);

    const rows = await openQuarantine();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.resolution).toBe('auto_applied');
    expect(row.resolvedAt).not.toBeNull();
  });

  it('does not let deltas advance the streak: only snapshots are consistent enough', async () => {
    const ids = await seedLibrary(100);
    const removal = ids.slice(0, 50);

    await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'snapshot', now: T0,
    });
    await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'delta', now: at(6),
    });
    const outcome = await applyRemovals(db, {
      serverId, userId, entryIds: removal, source: 'delta', now: at(12),
    });

    expect(outcome.quarantined).toBe(true);
    expect(outcome.occurrences).toBe(1);
    expect(await countEntries()).toBe(100);
  });

  it('breaks the streak when a snapshot proposes a different removal set', async () => {
    const ids = await seedLibrary(100);
    const first = ids.slice(0, 50);
    const second = ids.slice(20, 70);

    await applyRemovals(db, {
      serverId, userId, entryIds: first, source: 'snapshot', now: T0,
    });
    await applyRemovals(db, {
      serverId, userId, entryIds: second, source: 'snapshot', now: at(6),
    });
    // A flapping mount reports a different set each scan. The first set is no
    // longer proposed by the authority, so it must not keep its streak and
    // silently auto-apply later.
    const outcome = await applyRemovals(db, {
      serverId, userId, entryIds: second, source: 'snapshot', now: at(12),
    });

    expect(outcome.quarantined).toBe(true);
    expect(outcome.occurrences).toBe(2);
    expect(await countEntries()).toBe(100);

    const open = (await openQuarantine()).filter((r) => r.resolvedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.fingerprint).toBe(fingerprintEntryIds(second));
  });

  it('keeps one open row per removal set, however often it is proposed', async () => {
    const ids = await seedLibrary(100);
    const removal = ids.slice(0, 50);

    for (const hours of [0, 1, 2]) {
      await applyRemovals(db, {
        serverId, userId, entryIds: removal, source: 'snapshot', now: at(hours),
      });
    }

    const open = (await openQuarantine()).filter((r) => r.resolvedAt === null);
    expect(open).toHaveLength(1);
  });
});
