import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, newId, schema, type Database } from '@media-tracker/db';
import {
  createTestDatabase,
  hasTestDatabase,
  type TestDatabase,
} from '@media-tracker/db/testing';
import type { LibraryItem } from '@media-tracker/contracts';
import type { ResolveInput, Resolution } from '@media-tracker/tmdb';
import {
  applyDelta,
  applySyncChunk,
  finishSync,
  LibraryError,
  startSync,
  type LibraryDeps,
} from './library';

/**
 * S6.3. Deltas for latency, snapshots for correctness, and every removal from
 * either routed through the S7.6 safety valve.
 */

const T0 = new Date('2026-08-15T04:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe.skipIf(!hasTestDatabase())('library sync (S6.3)', () => {
  let harness: TestDatabase;
  let db: Database;
  let annaId: string;
  let bobId: string;
  let serverId: string;
  /** Shared across deps() calls in a test: one media item per title. */
  let mediaByTitle: Map<string, string>;
  let nextTmdbId: number;

  const ANNA_JF = 'jf-anna';
  const BOB_JF = 'jf-bob';

  beforeAll(async () => {
    harness = await createTestDatabase();
    db = harness.db;
  });

  afterAll(async () => {
    await harness?.drop();
  });

  beforeEach(async () => {
    await harness.sql`
      TRUNCATE library_syncs, library_sync_quarantine, library_entries,
               unmatched_items, episodes, media_items, server_accounts,
               servers, users RESTART IDENTITY CASCADE`;

    annaId = newId();
    bobId = newId();
    serverId = newId();
    mediaByTitle = new Map();
    nextTmdbId = 500_000;

    await db.insert(schema.users).values([
      { id: annaId, discordId: '100000000000000001', displayName: 'Anna' },
      { id: bobId, discordId: '100000000000000002', displayName: 'Bob' },
    ]);
    await db.insert(schema.servers).values({
      id: serverId,
      ownerUserId: annaId,
      name: 'LarsFlix',
      secretHash: 'x',
    });
    await db.insert(schema.serverAccounts).values([
      { serverId, jellyfinUserId: ANNA_JF, userId: annaId, linkState: 'linked', linkedAt: T0 },
      { serverId, jellyfinUserId: BOB_JF, userId: bobId, linkState: 'linked', linkedAt: T0 },
    ]);
  });

  /**
   * Resolver stub. Each distinct title gets its own media item, created on
   * demand, so library_entries_logical behaves as it would in production.
   */
  function deps(now: Date = T0): LibraryDeps {
    const resolve = async (input: ResolveInput): Promise<Resolution> => {
      if (input.name.startsWith('Unmatchable')) {
        return { status: 'unmatched', reason: 'no_provider_ids' };
      }
      let id = mediaByTitle.get(input.name);
      if (!id) {
        id = newId();
        mediaByTitle.set(input.name, id);
        await db.insert(schema.mediaItems).values({
          id,
          kind: 'movie',
          tmdbId: (nextTmdbId += 1),
          title: input.name,
        });
      }
      return { status: 'matched', mediaItemId: id, episodeId: null };
    };
    return { db, resolve, now: () => now };
  }

  const item = (n: number, overrides: Partial<LibraryItem> = {}): LibraryItem =>
    ({
      jellyfin_item_id: `jf-${n}`,
      item_type: 'Movie',
      name: `Film ${n}`,
      production_year: 2016,
      provider_ids: { Tmdb: String(600_000 + n) },
      series_provider_ids: {},
      ...overrides,
    }) as LibraryItem;

  const entriesFor = async (userId: string) =>
    await db
      .select()
      .from(schema.libraryEntries)
      .where(
        and(
          eq(schema.libraryEntries.userId, userId),
          eq(schema.libraryEntries.serverId, serverId),
        ),
      );

  // --- deltas -------------------------------------------------------------

  it('adds entries and reports what matched', async () => {
    const result = await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [item(1), item(2)],
      removed: [],
      updated: [],
    });

    expect(result).toMatchObject({ added: 2, removed: 0, updated: 0, unmatched: 0 });
    expect(await entriesFor(annaId)).toHaveLength(2);
  });

  it('stores the media profile, deduplicating language lists (S7.7)', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [
        item(1, {
          media: {
            container: 'mkv',
            video: { codec: 'hevc', width: 3840, height: 2160, range: 'HDR10' },
            audio: [
              { lang: 'en', codec: 'truehd' },
              { lang: 'de', codec: 'eac3' },
              { lang: 'de', codec: 'ac3' },
            ],
            subtitles: [{ lang: 'de', forced: false }],
          },
        }),
      ],
      removed: [],
      updated: [],
    });

    const [row] = await entriesFor(annaId);
    expect(row!.audioLangs).toEqual(['en', 'de']);
    expect(row!.subtitleLangs).toEqual(['de']);
    expect(row!.videoHeight).toBe(2160);
    expect(row!.videoRange).toBe('HDR10');
    expect(row!.profileSyncedAt).not.toBeNull();
  });

  it('leaves the profile columns null when the plugin omits media', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [item(1)],
      removed: [],
      updated: [],
    });

    const [row] = await entriesFor(annaId);
    expect(row!.audioLangs).toEqual([]);
    expect(row!.videoHeight).toBeNull();
    expect(row!.mediaProfile).toBeNull();
    expect(row!.profileSyncedAt).toBeNull();
  });

  it('overwrites the profile when a file is replaced in place', async () => {
    const sd = {
      video: { height: 1080, range: 'SDR' as const },
      audio: [{ lang: 'en' }],
      subtitles: [],
    };
    const uhd = {
      video: { height: 2160, range: 'HDR10' as const },
      audio: [{ lang: 'en' }, { lang: 'de' }],
      subtitles: [],
    };

    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [item(1, { media: sd })],
      removed: [],
      updated: [],
    });
    const result = await applyDelta(deps(at(5)), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [],
      removed: [],
      updated: [item(1, { media: uhd })],
    });

    expect(result.updated).toBe(1);
    const rows = await entriesFor(annaId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.videoHeight).toBe(2160);
    expect(rows[0]!.audioLangs).toEqual(['en', 'de']);
  });

  it('keeps an existing profile when the member turns profile reporting off', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [
        item(1, { media: { video: { height: 2160 }, audio: [{ lang: 'en' }], subtitles: [] } }),
      ],
      removed: [],
      updated: [],
    });
    await applyDelta(deps(at(5)), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [],
      removed: [],
      updated: [item(1)],
    });

    // Losing a good profile is worse than holding a slightly stale one.
    const [row] = await entriesFor(annaId);
    expect(row!.videoHeight).toBe(2160);
  });

  it('removes an entry by its Jellyfin item id alone', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: Array.from({ length: 40 }, (_, i) => item(i)),
      removed: [],
      updated: [],
    });

    const result = await applyDelta(deps(at(5)), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [],
      removed: [{ jellyfin_item_id: 'jf-1' }],
      updated: [],
    });

    expect(result.removed).toBe(1);
    expect(result.quarantined).toBe(false);
    expect(await entriesFor(annaId)).toHaveLength(39);
  });

  it('treats a removal for an unknown id as a silent no-op', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [item(1)],
      removed: [],
      updated: [],
    });

    const result = await applyDelta(deps(at(5)), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [],
      removed: [{ jellyfin_item_id: 'jf-never-existed' }],
      updated: [],
    });

    expect(result.removed).toBe(0);
    expect(await entriesFor(annaId)).toHaveLength(1);
  });

  it('routes a mass removal through the safety valve (S7.6)', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: Array.from({ length: 100 }, (_, i) => item(i)),
      removed: [],
      updated: [],
    });

    // The mount dropped and Jellyfin reported everything as gone.
    const result = await applyDelta(deps(at(5)), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [],
      removed: Array.from({ length: 100 }, (_, i) => ({ jellyfin_item_id: `jf-${i}` })),
      updated: [],
    });

    expect(result.quarantined).toBe(true);
    expect(result.removed).toBe(0);
    expect(await entriesFor(annaId)).toHaveLength(100);
  });

  it('records an unmatched item instead of guessing (S9)', async () => {
    const result = await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [item(1, { name: 'Unmatchable One' })],
      removed: [],
      updated: [],
    });

    expect(result.unmatched).toBe(1);
    expect(result.added).toBe(0);
    expect(await entriesFor(annaId)).toHaveLength(0);
    expect(await db.select().from(schema.unmatchedItems)).toHaveLength(1);
  });

  it('refuses an unlinked account but still records it for the linking UI', async () => {
    await expect(
      applyDelta(deps(), serverId, {
        jellyfin_user_id: 'jf-family-tv',
        added: [item(1)],
        removed: [],
        updated: [],
      }),
    ).rejects.toBeInstanceOf(LibraryError);

    const [account] = await db
      .select()
      .from(schema.serverAccounts)
      .where(eq(schema.serverAccounts.jellyfinUserId, 'jf-family-tv'));
    expect(account!.linkState).toBe('unlinked');
  });

  // --- many members on one server (C2) ------------------------------------

  it('lets two members on one server hold the same Jellyfin item', async () => {
    // S5.4 keys the identity index on (server, item) alone, which collides the
    // moment a second member on the same server reports the same file. That is
    // the LarsFlix case, and C2 exists because of it.
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [item(1)],
      removed: [],
      updated: [],
    });
    const result = await applyDelta(deps(), serverId, {
      jellyfin_user_id: BOB_JF,
      added: [item(1)],
      removed: [],
      updated: [],
    });

    expect(result.added).toBe(1);
    expect(await entriesFor(annaId)).toHaveLength(1);
    expect(await entriesFor(bobId)).toHaveLength(1);
  });

  it('scopes a removal to the member it was sent for', async () => {
    for (const jf of [ANNA_JF, BOB_JF]) {
      await applyDelta(deps(), serverId, {
        jellyfin_user_id: jf,
        added: Array.from({ length: 40 }, (_, i) => item(i)),
        removed: [],
        updated: [],
      });
    }

    await applyDelta(deps(at(5)), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: [],
      removed: [{ jellyfin_item_id: 'jf-1' }],
      updated: [],
    });

    expect(await entriesFor(annaId)).toHaveLength(39);
    expect(await entriesFor(bobId)).toHaveLength(40);
  });

  // --- full snapshot ------------------------------------------------------

  it('confirms what the snapshot contains and deletes what it does not', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: Array.from({ length: 40 }, (_, i) => item(i)),
      removed: [],
      updated: [],
    });

    const { sync_id } = await startSync(deps(at(60)), serverId, {
      jellyfin_user_id: ANNA_JF,
      estimated_count: 39,
    });
    await applySyncChunk(deps(at(61)), serverId, {
      sync_id,
      items: Array.from({ length: 39 }, (_, i) => item(i)),
    });
    const result = await finishSync(deps(at(62)), serverId, { sync_id });

    // jf-39 was not in the snapshot, so the server no longer has it.
    expect(result.removed).toBe(1);
    expect(result.quarantined).toBe(false);
    const remaining = await entriesFor(annaId);
    expect(remaining).toHaveLength(39);
    expect(remaining.map((r) => r.jellyfinItemId)).not.toContain('jf-39');
  });

  it('deletes nothing for a sync that never reaches finish', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: Array.from({ length: 40 }, (_, i) => item(i)),
      removed: [],
      updated: [],
    });

    // A snapshot starts, sends one chunk, and the server dies.
    const first = await startSync(deps(at(60)), serverId, { jellyfin_user_id: ANNA_JF });
    await applySyncChunk(deps(at(61)), serverId, { sync_id: first.sync_id, items: [item(0)] });

    // Hours later it tries again. The abandoned run must not delete the 39
    // entries it never got round to confirming.
    await startSync(deps(at(600)), serverId, { jellyfin_user_id: ANNA_JF });

    expect(await entriesFor(annaId)).toHaveLength(40);
    const [stale] = await db
      .select()
      .from(schema.librarySyncs)
      .where(eq(schema.librarySyncs.id, first.sync_id));
    expect(stale!.state).toBe('abandoned');
  });

  it('refuses a chunk or finish for a sync that is no longer open', async () => {
    const { sync_id } = await startSync(deps(at(60)), serverId, { jellyfin_user_id: ANNA_JF });
    await finishSync(deps(at(61)), serverId, { sync_id });

    await expect(
      applySyncChunk(deps(at(62)), serverId, { sync_id, items: [item(1)] }),
    ).rejects.toBeInstanceOf(LibraryError);
    await expect(
      finishSync(deps(at(63)), serverId, { sync_id }),
    ).rejects.toBeInstanceOf(LibraryError);
  });

  it('refuses an unknown sync id', async () => {
    await expect(
      finishSync(deps(), serverId, { sync_id: newId() }),
    ).rejects.toBeInstanceOf(LibraryError);
  });

  it('will not let one server finish another server’s sync', async () => {
    const otherServerId = newId();
    await db.insert(schema.servers).values({
      id: otherServerId,
      ownerUserId: annaId,
      name: 'Anna NAS',
      secretHash: 'y',
    });

    const { sync_id } = await startSync(deps(), serverId, { jellyfin_user_id: ANNA_JF });

    await expect(
      finishSync(deps(), otherServerId, { sync_id }),
    ).rejects.toBeInstanceOf(LibraryError);
  });

  it('sends snapshot reconciliation through the safety valve too', async () => {
    await applyDelta(deps(), serverId, {
      jellyfin_user_id: ANNA_JF,
      added: Array.from({ length: 100 }, (_, i) => item(i)),
      removed: [],
      updated: [],
    });

    // The mount was down when the scan ran, so the snapshot is nearly empty.
    const { sync_id } = await startSync(deps(at(60)), serverId, { jellyfin_user_id: ANNA_JF });
    await applySyncChunk(deps(at(61)), serverId, { sync_id, items: [item(0)] });
    const result = await finishSync(deps(at(62)), serverId, { sync_id });

    expect(result.quarantined).toBe(true);
    expect(result.removed).toBe(0);
    expect(await entriesFor(annaId)).toHaveLength(100);
  });

  it('reports unmatched items from the snapshot on finish', async () => {
    const { sync_id } = await startSync(deps(), serverId, { jellyfin_user_id: ANNA_JF });
    await applySyncChunk(deps(at(1)), serverId, {
      sync_id,
      items: [item(1), item(2, { name: 'Unmatchable Two' })],
    });
    const result = await finishSync(deps(at(2)), serverId, { sync_id });

    expect(result.added).toBe(1);
    expect(result.unmatched).toBe(1);
  });
});
