import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, newId, schema, type Database } from '@media-tracker/db';
import {
  createTestDatabase,
  hasTestDatabase,
  type TestDatabase,
} from '@media-tracker/db/testing';
import type { IngestEvent } from '@media-tracker/contracts';
import type { ResolveInput, Resolution } from '@media-tracker/tmdb';
import { ingestEvents, type IngestDeps } from './ingest';

/**
 * S6.2. The rules under test are the ones that protect a member from the
 * server their account happens to live on (C2, C3), plus the retry contract
 * the plugin's outbound queue depends on (S7.3).
 */

const T0 = new Date('2026-08-15T20:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe.skipIf(!hasTestDatabase())('ingestEvents (S6.2)', () => {
  let harness: TestDatabase;
  let db: Database;
  let userId: string;
  let serverId: string;
  let otherServerId: string;
  let movieId: string;
  let showId: string;
  let episodeId: string;
  let otherEpisodeId: string;

  const JF_USER = 'jf-anna';
  const UNLINKED_JF_USER = 'jf-family-tv';

  beforeAll(async () => {
    harness = await createTestDatabase();
    db = harness.db;
  });

  afterAll(async () => {
    await harness?.drop();
  });

  beforeEach(async () => {
    await harness.sql`
      TRUNCATE watch_events, playback_sessions, unmatched_items, episodes,
               media_items, server_accounts, servers, users
      RESTART IDENTITY CASCADE`;

    userId = newId();
    serverId = newId();
    otherServerId = newId();
    movieId = newId();
    showId = newId();
    episodeId = newId();
    otherEpisodeId = newId();

    await db.insert(schema.users).values({
      id: userId,
      discordId: '100000000000000001',
      displayName: 'Anna',
    });
    await db.insert(schema.servers).values([
      { id: serverId, ownerUserId: userId, name: 'LarsFlix', secretHash: 'x' },
      { id: otherServerId, ownerUserId: userId, name: 'Anna NAS', secretHash: 'y' },
    ]);
    await db.insert(schema.serverAccounts).values({
      serverId,
      jellyfinUserId: JF_USER,
      jellyfinUsername: 'anna',
      userId,
      linkState: 'linked',
      linkedAt: T0,
    });
    await db.insert(schema.mediaItems).values([
      { id: movieId, kind: 'movie', tmdbId: 330459, title: 'Rogue One' },
      { id: showId, kind: 'show', tmdbId: 83867, title: 'Andor' },
    ]);
    await db.insert(schema.episodes).values([
      { id: episodeId, showId, season: 1, number: 3, title: 'Reckoning' },
      { id: otherEpisodeId, showId, season: 1, number: 4, title: 'Aldhani' },
    ]);
  });

  /** Resolver stub: the item's jellyfin id decides the outcome (S9 is tested separately). */
  function deps(now: Date = T0): IngestDeps {
    const resolve = async (input: ResolveInput): Promise<Resolution> => {
      if (input.name === 'Unmatchable') {
        return { status: 'unmatched', reason: 'no_provider_ids' };
      }
      if (input.item_type === 'Episode') {
        return {
          status: 'matched',
          mediaItemId: showId,
          episodeId: input.episode === 4 ? otherEpisodeId : episodeId,
        };
      }
      return { status: 'matched', mediaItemId: movieId, episodeId: null };
    };
    return { db, resolve, now: () => now };
  }

  function event(overrides: Partial<IngestEvent> = {}): IngestEvent {
    return {
      idempotency_key: newId(),
      jellyfin_user_id: JF_USER,
      type: 'item.played',
      occurred_at: T0.toISOString(),
      session_id: 'sess-1',
      item: {
        jellyfin_item_id: 'jf-item-1',
        item_type: 'Movie',
        name: 'Rogue One',
        production_year: 2016,
        provider_ids: { Tmdb: '330459' },
        series_provider_ids: {},
      },
      position_sec: 2400,
      runtime_sec: 2610,
      is_paused: false,
      device: 'webOS',
      ...overrides,
    } as IngestEvent;
  }

  const episodeEvent = (episode: number, overrides: Partial<IngestEvent> = {}) =>
    event({
      item: {
        jellyfin_item_id: `jf-ep-${episode}`,
        item_type: 'Episode',
        name: `Episode ${episode}`,
        series_name: 'Andor',
        season: 1,
        episode,
        provider_ids: {},
        series_provider_ids: { Tmdb: '83867' },
      },
      ...overrides,
    });

  const watches = async () => await db.select().from(schema.watchEvents);
  const sessions = async () => await db.select().from(schema.playbackSessions);
  const unmatched = async () => await db.select().from(schema.unmatchedItems);

  // --- identity (C2) ------------------------------------------------------

  it('drops events for an unlinked account but still records the account', async () => {
    const result = await ingestEvents(deps(), serverId, [
      event({ jellyfin_user_id: UNLINKED_JF_USER }),
    ]);

    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]!.reason).toBe('unlinked_account');
    expect(await watches()).toHaveLength(0);

    // S6.2: the row is upserted anyway, so the owner can see and invite them.
    const [account] = await db
      .select()
      .from(schema.serverAccounts)
      .where(eq(schema.serverAccounts.jellyfinUserId, UNLINKED_JF_USER));
    expect(account!.linkState).toBe('unlinked');
    expect(account!.userId).toBeNull();
  });

  it('marks an unlinked rejection permanent, so pre-consent watches are not replayed', async () => {
    // S8 is two-sided consent. Banking events from before the member agreed
    // and flushing them on link would make the consent retroactive.
    const result = await ingestEvents(deps(), serverId, [
      event({ jellyfin_user_id: UNLINKED_JF_USER }),
    ]);
    expect(result.errors[0]!.permanent).toBe(true);
  });

  it('drops events for a pending account', async () => {
    await db.insert(schema.serverAccounts).values({
      serverId,
      jellyfinUserId: 'jf-pending',
      linkState: 'pending',
    });

    const result = await ingestEvents(deps(), serverId, [
      event({ jellyfin_user_id: 'jf-pending' }),
    ]);

    expect(result.rejected).toBe(1);
    expect(result.errors[0]!.reason).toBe('unlinked_account');
    expect(await watches()).toHaveLength(0);
  });

  it('refuses an account that is linked only on a different server', async () => {
    // C2: the same Jellyfin username on someone else's box is a different
    // account. A link on Anna's NAS must not let LarsFlix speak for her.
    await db.insert(schema.serverAccounts).values({
      serverId: otherServerId,
      jellyfinUserId: 'jf-bob',
      userId,
      linkState: 'linked',
      linkedAt: T0,
    });

    const result = await ingestEvents(deps(), serverId, [
      event({ jellyfin_user_id: 'jf-bob' }),
    ]);

    expect(result.accepted).toBe(0);
    expect(result.errors[0]!.reason).toBe('unlinked_account');
    expect(await watches()).toHaveLength(0);
  });

  it('stamps the sending server on every row it accepts', async () => {
    // S2.2 C3: every derived row carries source_server_id so one server's data
    // can be disowned wholesale.
    await db.insert(schema.serverAccounts).values({
      serverId: otherServerId,
      jellyfinUserId: JF_USER,
      userId,
      linkState: 'linked',
      linkedAt: T0,
    });

    await ingestEvents(deps(), otherServerId, [event()]);

    const [row] = await watches();
    expect(row!.sourceServerId).toBe(otherServerId);
  });

  it('does not let a rejected link resume ingest', async () => {
    await db
      .update(schema.serverAccounts)
      .set({ linkState: 'rejected', userId: null })
      .where(eq(schema.serverAccounts.jellyfinUserId, JF_USER));

    const result = await ingestEvents(deps(), serverId, [event()]);

    expect(result.rejected).toBe(1);
    expect(await watches()).toHaveLength(0);
  });

  // --- item.played --------------------------------------------------------

  it('records a watch event for item.played', async () => {
    const result = await ingestEvents(deps(), serverId, [event()]);

    expect(result.accepted).toBe(1);
    const [row] = await watches();
    expect(row!.userId).toBe(userId);
    expect(row!.mediaItemId).toBe(movieId);
    expect(row!.episodeId).toBeNull();
    expect(row!.source).toBe('jellyfin');
    expect(row!.sourceServerId).toBe(serverId);
    expect(row!.isRewatch).toBe(false);
    expect(row!.progressPct).toBe(92);
  });

  it('computes is_rewatch at insert, per user, item and episode', async () => {
    await ingestEvents(deps(), serverId, [episodeEvent(3)]);
    await ingestEvents(deps(), serverId, [episodeEvent(3)]);
    await ingestEvents(deps(), serverId, [episodeEvent(4)]);

    const rows = await watches();
    const forEpisode = (id: string) => rows.filter((r) => r.episodeId === id);

    expect(forEpisode(episodeId).map((r) => r.isRewatch).sort()).toEqual([
      false,
      true,
    ]);
    // A different episode of the same show is not a rewatch.
    expect(forEpisode(otherEpisodeId)[0]!.isRewatch).toBe(false);
  });

  it('is idempotent: a replayed batch changes nothing and still reports accepted', async () => {
    const e = event();

    const first = await ingestEvents(deps(), serverId, [e]);
    const second = await ingestEvents(deps(), serverId, [e]);

    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(1);
    expect(await watches()).toHaveLength(1);
  });

  it('scopes idempotency per server, so two servers cannot silence each other', async () => {
    await db.insert(schema.serverAccounts).values({
      serverId: otherServerId,
      jellyfinUserId: JF_USER,
      userId,
      linkState: 'linked',
      linkedAt: T0,
    });
    const e = event({ idempotency_key: 'shared-key' });

    await ingestEvents(deps(), serverId, [e]);
    await ingestEvents(deps(), otherServerId, [e]);

    expect(await watches()).toHaveLength(2);
  });

  it('keeps a delayed watch event: that is what the outbound queue is for', async () => {
    // Ten minutes of tracker downtime, then the plugin flushes (S7.3).
    const result = await ingestEvents(deps(at(10)), serverId, [
      event({ occurred_at: T0.toISOString() }),
    ]);

    expect(result.accepted).toBe(1);
    const [row] = await watches();
    expect(row!.watchedAt.toISOString()).toBe(T0.toISOString());
  });

  it('leaves progress_pct null when the plugin sent no runtime', async () => {
    await ingestEvents(deps(), serverId, [
      event({ position_sec: 800, runtime_sec: null }),
    ]);
    expect((await watches())[0]!.progressPct).toBeNull();
  });

  // --- sessions -----------------------------------------------------------

  it('opens a session on playback.start and updates it on progress', async () => {
    await ingestEvents(deps(), serverId, [
      event({ type: 'playback.start', position_sec: 0 }),
    ]);
    const [opened] = await sessions();
    expect(opened!.positionSec).toBe(0);
    expect(opened!.userId).toBe(userId);

    await ingestEvents(deps(at(1)), serverId, [
      event({
        type: 'playback.progress',
        position_sec: 640,
        occurred_at: at(1).toISOString(),
      }),
    ]);

    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.positionSec).toBe(640);
    // Every heartbeat pushes the TTL out (S5.3).
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(
      opened!.expiresAt.getTime(),
    );
  });

  it('closes the session on playback.stop', async () => {
    await ingestEvents(deps(), serverId, [event({ type: 'playback.start' })]);
    expect(await sessions()).toHaveLength(1);

    await ingestEvents(deps(), serverId, [event({ type: 'playback.stop' })]);
    expect(await sessions()).toHaveLength(0);
  });

  it('does not resurrect now-playing from a stale backlog', async () => {
    // The member's server was offline for an hour and is now flushing. These
    // sessions ended long ago; replaying them would show them as live.
    const result = await ingestEvents(deps(at(60)), serverId, [
      event({ type: 'playback.progress', occurred_at: T0.toISOString() }),
    ]);

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(await sessions()).toHaveLength(0);
  });

  it('puts the session TTL on the tracker clock, not the sender', async () => {
    // A member's server with a skewed clock must not expire its own sessions.
    const now = at(1);
    await ingestEvents(deps(now), serverId, [
      event({ type: 'playback.start', occurred_at: at(-1).toISOString() }),
    ]);

    const [row] = await sessions();
    expect(row!.expiresAt.getTime()).toBe(now.getTime() + 2 * 60_000);
  });

  // --- unmatched (S9) -----------------------------------------------------

  it('quarantines an unmatched item instead of guessing', async () => {
    const result = await ingestEvents(deps(), serverId, [
      event({
        item: {
          jellyfin_item_id: 'jf-weird',
          item_type: 'Movie',
          name: 'Unmatchable',
          provider_ids: {},
          series_provider_ids: {},
        },
      }),
    ]);

    expect(result.unmatched).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(0);
    expect(await watches()).toHaveLength(0);

    const [row] = await unmatched();
    expect(row!.jellyfinItemId).toBe('jf-weird');
    // The plugin must retry: an admin resolving the item is what backfills it.
    expect(result.errors[0]!.permanent).toBe(false);
  });

  it('never records a path or filename for an unmatched item', async () => {
    await ingestEvents(deps(), serverId, [
      event({
        item: {
          jellyfin_item_id: 'jf-weird',
          item_type: 'Movie',
          name: 'Unmatchable',
          provider_ids: {},
          series_provider_ids: {},
        },
      }),
    ]);

    const [row] = await unmatched();
    const keys = Object.keys(row!.raw as Record<string, unknown>);
    expect(keys).not.toContain('path');
    expect(JSON.stringify(row!.raw)).not.toMatch(/\/|\\\\/);
  });

  it('updates last_seen_at when the same unmatched item comes back', async () => {
    const unmatchable = {
      jellyfin_item_id: 'jf-weird',
      item_type: 'Movie' as const,
      name: 'Unmatchable',
      provider_ids: {},
      series_provider_ids: {},
    };
    await ingestEvents(deps(), serverId, [event({ item: unmatchable })]);
    await ingestEvents(deps(at(30)), serverId, [event({ item: unmatchable })]);

    const rows = await unmatched();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastSeenAt.toISOString()).toBe(at(30).toISOString());
    expect(rows[0]!.firstSeenAt.toISOString()).toBe(T0.toISOString());
  });

  // --- batching -----------------------------------------------------------

  it('reports each event separately: one bad title does not fail the batch', async () => {
    const result = await ingestEvents(deps(), serverId, [
      event(),
      event({ jellyfin_user_id: UNLINKED_JF_USER }),
      event({
        item: {
          jellyfin_item_id: 'jf-weird',
          item_type: 'Movie',
          name: 'Unmatchable',
          provider_ids: {},
          series_provider_ids: {},
        },
      }),
      episodeEvent(3),
    ]);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(await watches()).toHaveLength(2);
  });

  it('reports a resolver failure as retryable rather than losing the event', async () => {
    const failing: IngestDeps = {
      db,
      now: () => T0,
      resolve: async () => {
        throw new Error('TMDB unreachable');
      },
    };

    const result = await ingestEvents(failing, serverId, [event()]);

    expect(result.rejected).toBe(1);
    expect(result.errors[0]!.permanent).toBe(false);
    expect(await watches()).toHaveLength(0);
  });
});
