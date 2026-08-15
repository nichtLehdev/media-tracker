import type {
  LibraryDeltaRequest,
  LibraryDeltaResponse,
  LibraryItem,
  MediaProfile,
} from '@media-tracker/contracts';
import type { ResolveInput, Resolution } from '@media-tracker/tmdb';
import { and, eq, inArray, lt, newId, schema, type Database } from '@media-tracker/db';
import { applyRemovals } from './library-quarantine';
import { recordUnmatched } from './unmatched';

/**
 * S6.3. Two mechanisms with different jobs: deltas exist for latency, and the
 * nightly snapshot exists because deltas are lossy and nobody notices when
 * they go wrong. Both funnel their removals through the same safety valve
 * (S7.6) -- that is the whole point of it being a separate module.
 */

export interface LibraryDeps {
  db: Database;
  resolve(input: ResolveInput): Promise<Resolution>;
  now?: () => Date;
}

export class LibraryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * S7.4 runs the snapshot per local Jellyfin user, because the plugin does not
 * know which accounts are linked. The spec says the tracker discards the
 * unlinked ones; discovering that here rather than after 4000 items have been
 * uploaded is the same outcome for a fraction of the traffic.
 *
 * The account row is upserted first, so an unlinked member still appears in
 * the owner's linking UI (S6.2 does the same at ingest).
 */
async function requireLinkedUser(
  db: Database,
  serverId: string,
  jellyfinUserId: string,
): Promise<string> {
  await db
    .insert(schema.serverAccounts)
    .values({ serverId, jellyfinUserId, linkState: 'unlinked' })
    .onConflictDoNothing({
      target: [
        schema.serverAccounts.serverId,
        schema.serverAccounts.jellyfinUserId,
      ],
    });

  const [account] = await db
    .select({
      userId: schema.serverAccounts.userId,
      linkState: schema.serverAccounts.linkState,
    })
    .from(schema.serverAccounts)
    .where(
      and(
        eq(schema.serverAccounts.serverId, serverId),
        eq(schema.serverAccounts.jellyfinUserId, jellyfinUserId),
      ),
    )
    .limit(1);

  if (!account?.userId || account.linkState !== 'linked') {
    throw new LibraryError(409, 'unlinked_account');
  }
  return account.userId;
}

interface UpsertResult {
  matched: boolean;
}

/**
 * Adds or refreshes one entry. Returns whether it resolved at all; callers
 * count the misses for the response.
 */
async function upsertEntry(
  deps: LibraryDeps,
  args: {
    serverId: string;
    userId: string;
    item: LibraryItem;
    confirmedAt: Date;
  },
): Promise<UpsertResult> {
  const { db } = deps;
  const { serverId, userId, item, confirmedAt } = args;

  const resolution = await deps.resolve(toResolveInput(item));
  if (resolution.status === 'unmatched') {
    await recordUnmatched(db, serverId, item, confirmedAt);
    return { matched: false };
  }

  const profile = profileColumns(item.media, confirmedAt);

  try {
    await db
      .insert(schema.libraryEntries)
      .values({
        id: newId(),
        userId,
        serverId,
        mediaItemId: resolution.mediaItemId,
        episodeId: resolution.episodeId,
        jellyfinItemId: item.jellyfin_item_id,
        firstSeenAt: confirmedAt,
        lastConfirmedAt: confirmedAt,
        ...profile,
      })
      .onConflictDoUpdate({
        target: [
          schema.libraryEntries.serverId,
          schema.libraryEntries.userId,
          schema.libraryEntries.jellyfinItemId,
        ],
        set: {
          mediaItemId: resolution.mediaItemId,
          episodeId: resolution.episodeId,
          lastConfirmedAt: confirmedAt,
          ...profile,
        },
      });
  } catch (err) {
    // library_entries_logical holds one row per title per server, but a member
    // can have the same film as two Jellyfin items (a 1080p and a 4K library,
    // say). The title is already available to them, so the second file is a
    // no-op rather than an error. Removing the recorded copy drops
    // availability until the next snapshot restores it from the other -- which
    // is precisely the silent failure the snapshot exists to repair (S7.4).
    if (!isLogicalConflict(err)) throw err;
  }

  return { matched: true };
}

const isLogicalConflict = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: string }).code === '23505' &&
  String((err as { constraint_name?: string }).constraint_name ?? '').includes(
    'library_entries_logical',
  );

/**
 * S7.7. `media` is omitted when the member turned profile reporting off; the
 * existing profile is then left alone rather than nulled, because losing a
 * good profile is worse than holding a slightly stale one.
 */
function profileColumns(media: MediaProfile | undefined, now: Date) {
  if (!media) return {};
  const langs = (xs: { lang: string }[]) => [...new Set(xs.map((x) => x.lang))];
  return {
    audioLangs: langs(media.audio),
    subtitleLangs: langs(media.subtitles),
    videoHeight: media.video?.height ?? null,
    videoRange: media.video?.range ?? null,
    mediaProfile: media,
    profileSyncedAt: now,
  };
}

const toResolveInput = (item: LibraryItem): ResolveInput => ({
  item_type: item.item_type,
  name: item.name,
  production_year: item.production_year,
  series_name: item.series_name,
  season: item.season,
  episode: item.episode,
  provider_ids: item.provider_ids,
  series_provider_ids: item.series_provider_ids,
});

// --- deltas (S6.3.1) -------------------------------------------------------

export async function applyDelta(
  deps: LibraryDeps,
  serverId: string,
  request: LibraryDeltaRequest,
): Promise<LibraryDeltaResponse> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const userId = await requireLinkedUser(db, serverId, request.jellyfin_user_id);

  let unmatched = 0;
  let added = 0;
  let updated = 0;

  for (const item of request.added) {
    const r = await upsertEntry(deps, { serverId, userId, item, confirmedAt: now });
    if (r.matched) added += 1;
    else unmatched += 1;
  }
  // `updated` is a file replaced in place: same Jellyfin item, new profile.
  // Structurally identical to an add, so it goes through the same upsert.
  for (const item of request.updated) {
    const r = await upsertEntry(deps, { serverId, userId, item, confirmedAt: now });
    if (r.matched) updated += 1;
    else unmatched += 1;
  }

  const outcome = await removeByJellyfinIds(
    deps,
    serverId,
    userId,
    request.removed.map((r) => r.jellyfin_item_id),
    'delta',
    now,
  );

  return {
    added,
    updated,
    removed: outcome.removed,
    unmatched,
    quarantined: outcome.quarantined,
  };
}

/**
 * S6.3.1: removals carry only a Jellyfin item id -- the item is already gone
 * from the sending server, so there is no metadata to re-resolve. A removal
 * for an id the tracker does not know is a silent no-op, not an error.
 */
async function removeByJellyfinIds(
  deps: LibraryDeps,
  serverId: string,
  userId: string,
  jellyfinItemIds: readonly string[],
  source: 'delta' | 'snapshot',
  now: Date,
) {
  if (jellyfinItemIds.length === 0) {
    return { removed: 0, quarantined: false };
  }

  const rows = await deps.db
    .select({ id: schema.libraryEntries.id })
    .from(schema.libraryEntries)
    .where(
      and(
        eq(schema.libraryEntries.serverId, serverId),
        eq(schema.libraryEntries.userId, userId),
        inArray(schema.libraryEntries.jellyfinItemId, [...jellyfinItemIds]),
      ),
    );

  const outcome = await applyRemovals(deps.db, {
    serverId,
    userId,
    entryIds: rows.map((r) => r.id),
    source,
    now,
  });
  return { removed: outcome.removed, quarantined: outcome.quarantined };
}

// --- full snapshot (S6.3.2) ------------------------------------------------

export async function startSync(
  deps: LibraryDeps,
  serverId: string,
  request: { jellyfin_user_id: string; estimated_count?: number },
): Promise<{ sync_id: string }> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const userId = await requireLinkedUser(db, serverId, request.jellyfin_user_id);

  // A previous run that never reached finish is abandoned, not resumed: its
  // confirmations are older than this run's start and would look like
  // removals. Abandoning it deletes nothing (S6.3.2).
  await db
    .update(schema.librarySyncs)
    .set({ state: 'abandoned', finishedAt: now })
    .where(
      and(
        eq(schema.librarySyncs.serverId, serverId),
        eq(schema.librarySyncs.userId, userId),
        eq(schema.librarySyncs.state, 'open'),
      ),
    );

  const id = newId();
  await db.insert(schema.librarySyncs).values({
    id,
    serverId,
    userId,
    jellyfinUserId: request.jellyfin_user_id,
    estimatedCount: request.estimated_count ?? null,
    state: 'open',
    startedAt: now,
  });

  return { sync_id: id };
}

async function openSync(db: Database, serverId: string, syncId: string) {
  const [sync] = await db
    .select()
    .from(schema.librarySyncs)
    .where(
      and(
        eq(schema.librarySyncs.id, syncId),
        eq(schema.librarySyncs.serverId, serverId),
      ),
    )
    .limit(1);

  if (!sync) throw new LibraryError(404, 'unknown_sync');
  if (sync.state !== 'open') throw new LibraryError(409, 'sync_not_open');
  return sync;
}

export async function applySyncChunk(
  deps: LibraryDeps,
  serverId: string,
  request: { sync_id: string; items: LibraryItem[] },
): Promise<{ accepted: number; unmatched: number }> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const sync = await openSync(db, serverId, request.sync_id);

  let accepted = 0;
  let unmatched = 0;
  for (const item of request.items) {
    const r = await upsertEntry(deps, {
      serverId,
      userId: sync.userId,
      item,
      confirmedAt: now,
    });
    if (r.matched) accepted += 1;
    else unmatched += 1;
  }

  await db
    .update(schema.librarySyncs)
    .set({
      itemsSeen: sync.itemsSeen + request.items.length,
      unmatchedCount: sync.unmatchedCount + unmatched,
    })
    .where(eq(schema.librarySyncs.id, sync.id));

  return { accepted, unmatched };
}

/**
 * S6.3.2: on finish, delete entries whose last_confirmed_at predates the sync
 * start -- they were not in the snapshot, so the server no longer has them.
 * Never on a sync that did not reach finish: a crashed sync must not wipe a
 * member's library.
 */
export async function finishSync(
  deps: LibraryDeps,
  serverId: string,
  request: { sync_id: string },
): Promise<{
  added: number;
  removed: number;
  unmatched: number;
  quarantined: boolean;
}> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const sync = await openSync(db, serverId, request.sync_id);

  const stale = await db
    .select({ id: schema.libraryEntries.id })
    .from(schema.libraryEntries)
    .where(
      and(
        eq(schema.libraryEntries.serverId, serverId),
        eq(schema.libraryEntries.userId, sync.userId),
        lt(schema.libraryEntries.lastConfirmedAt, sync.startedAt),
      ),
    );

  const outcome = await applyRemovals(db, {
    serverId,
    userId: sync.userId,
    entryIds: stale.map((r) => r.id),
    source: 'snapshot',
    now,
  });

  await db
    .update(schema.librarySyncs)
    .set({ state: 'finished', finishedAt: now })
    .where(eq(schema.librarySyncs.id, sync.id));

  return {
    added: sync.itemsSeen - sync.unmatchedCount,
    removed: outcome.removed,
    unmatched: sync.unmatchedCount,
    quarantined: outcome.quarantined,
  };
}
