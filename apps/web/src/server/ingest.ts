import type {
  IngestEvent,
  IngestItem,
  IngestResponse,
} from '@media-tracker/contracts';
import type { ResolveInput, Resolution } from '@media-tracker/tmdb';
import {
  and,
  eq,
  isNull,
  newId,
  schema,
  sql,
  type Database,
} from '@media-tracker/db';

/**
 * S6.2. The plugin pushes batches here; this is where a raw jellyfin_user_id
 * becomes a tracker identity, and the only place it is allowed to.
 *
 * Three rules from the spec shape everything below:
 *
 *   - Never trust identity (C2). The payload carries a Jellyfin user id and
 *     nothing else; the mapping lives in server_accounts, for this server.
 *   - `item.played` is the only watched signal. Jellyfin has already applied
 *     the member's own completion threshold and fires PlaybackFinished, and it
 *     fires again on a rewatch. Deriving "watched" from a stop event and a
 *     percentage would both double count and disagree with their settings.
 *   - The plugin may only drop an event the tracker accepted, or rejected as
 *     permanent. Everything else it must keep and retry, so `permanent` is a
 *     promise about whether retrying could ever succeed.
 */

/** S5.3: every heartbeat pushes the TTL out by this much. */
const SESSION_TTL_MS = 2 * 60 * 1000;

/**
 * A queued backlog flushed after the member's server was offline must not
 * resurrect "now playing" for something that finished an hour ago. Playback
 * events older than this are accepted and ignored rather than applied to a
 * session. `item.played` is deliberately exempt: a delayed watch event is
 * exactly what the outbound queue exists to preserve (S7.3).
 */
const SESSION_STALE_AFTER_MS = 5 * 60 * 1000;

export interface IngestDeps {
  db: Database;
  /** S9. Injected rather than constructed so tests need no TMDB. */
  resolve(input: ResolveInput): Promise<Resolution>;
  now?: () => Date;
}

type Outcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; reason: 'unlinked_account' | 'invalid'; permanent: boolean; message?: string }
  | { kind: 'unmatched'; message?: string };

export async function ingestEvents(
  deps: IngestDeps,
  serverId: string,
  events: readonly IngestEvent[],
): Promise<IngestResponse> {
  const now = deps.now ?? (() => new Date());
  const response: IngestResponse = {
    accepted: 0,
    rejected: 0,
    unmatched: 0,
    errors: [],
  };

  // Sequential on purpose: session upserts for one jellyfin session must apply
  // in the order the plugin queued them, or a stop can land before its start.
  for (const event of events) {
    let outcome: Outcome;
    try {
      outcome = await ingestOne(deps, serverId, event, now());
    } catch (err) {
      // Unknown failures are the tracker's fault, so they are never permanent:
      // the plugin keeps the event and tries again.
      outcome = {
        kind: 'rejected',
        reason: 'invalid',
        permanent: false,
        message: err instanceof Error ? err.message : 'internal error',
      };
    }

    if (outcome.kind === 'accepted') {
      response.accepted += 1;
      continue;
    }

    if (outcome.kind === 'unmatched') {
      response.unmatched += 1;
      response.errors.push({
        idempotency_key: event.idempotency_key,
        reason: 'unmatched',
        // S9: an admin can resolve the item later, and the plugin's own retry
        // is what then backfills the event -- the tracker has nowhere to hold
        // a watch event with no media_item_id.
        permanent: false,
        message: outcome.message,
      });
      continue;
    }

    response.rejected += 1;
    response.errors.push({
      idempotency_key: event.idempotency_key,
      reason: outcome.reason,
      permanent: outcome.permanent,
      message: outcome.message,
    });
  }

  return response;
}

async function ingestOne(
  deps: IngestDeps,
  serverId: string,
  event: IngestEvent,
  now: Date,
): Promise<Outcome> {
  const { db } = deps;
  // The wire format carries an ISO string (S6.2); everything below wants a Date.
  const occurredAt = new Date(event.occurred_at);

  // S6.2: the account row is upserted even when the event is dropped, so an
  // unlinked member still shows up in the owner's linking UI. Only the member
  // accepting an invite may move link_state (C2), so this touches nothing else.
  await db
    .insert(schema.serverAccounts)
    .values({
      serverId,
      jellyfinUserId: event.jellyfin_user_id,
      linkState: 'unlinked',
    })
    .onConflictDoNothing({
      target: [schema.serverAccounts.serverId, schema.serverAccounts.jellyfinUserId],
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
        eq(schema.serverAccounts.jellyfinUserId, event.jellyfin_user_id),
      ),
    )
    .limit(1);

  if (!account?.userId || account.linkState !== 'linked') {
    return {
      kind: 'rejected',
      reason: 'unlinked_account',
      // Permanent by design, not by limitation. Attributing watches from
      // before the member consented would defeat the two-sided linking in S8,
      // so these events are meant to be lost rather than replayed on link.
      permanent: true,
      message: `account is ${account?.linkState ?? 'unknown'}`,
    };
  }
  const userId = account.userId;

  if (event.type === 'playback.stop') {
    await db
      .delete(schema.playbackSessions)
      .where(
        and(
          eq(schema.playbackSessions.serverId, serverId),
          eq(schema.playbackSessions.jellyfinSessionId, sessionKey(event)),
        ),
      );
    return { kind: 'accepted' };
  }

  const resolution = await deps.resolve(toResolveInput(event.item));
  if (resolution.status === 'unmatched') {
    await recordUnmatched(db, serverId, event.item, now);
    return { kind: 'unmatched', message: resolution.reason };
  }

  if (event.type === 'item.played') {
    await recordWatch(db, {
      userId,
      serverId,
      mediaItemId: resolution.mediaItemId,
      episodeId: resolution.episodeId,
      event,
      occurredAt,
    });
    return { kind: 'accepted' };
  }

  // playback.start | playback.progress
  if (now.getTime() - occurredAt.getTime() > SESSION_STALE_AFTER_MS) {
    return { kind: 'accepted' };
  }
  await upsertSession(db, {
    userId,
    serverId,
    mediaItemId: resolution.mediaItemId,
    episodeId: resolution.episodeId,
    event,
    occurredAt,
    now,
  });
  return { kind: 'accepted' };
}

/**
 * Jellyfin does not always carry a session id (UserDataSaved has none). Falling
 * back to the item keeps the unique key stable for the events that do create
 * sessions.
 */
const sessionKey = (event: IngestEvent): string =>
  event.session_id ?? `item:${event.item.jellyfin_item_id}`;

const toResolveInput = (item: IngestItem): ResolveInput => ({
  item_type: item.item_type,
  name: item.name,
  production_year: item.production_year,
  series_name: item.series_name,
  season: item.season,
  episode: item.episode,
  provider_ids: item.provider_ids,
  series_provider_ids: item.series_provider_ids,
});

async function recordWatch(
  db: Database,
  args: {
    userId: string;
    serverId: string;
    mediaItemId: string;
    episodeId: string | null;
    event: IngestEvent;
    occurredAt: Date;
  },
): Promise<void> {
  const { userId, serverId, mediaItemId, episodeId, event, occurredAt } = args;

  const episodeMatches = episodeId
    ? eq(schema.watchEvents.episodeId, episodeId)
    : isNull(schema.watchEvents.episodeId);

  // S5.3: computed at insert, never sent by the plugin -- a server could
  // otherwise mislabel a member's first watch as a rewatch.
  const [prior] = await db
    .select({ id: schema.watchEvents.id })
    .from(schema.watchEvents)
    .where(
      and(
        eq(schema.watchEvents.userId, userId),
        eq(schema.watchEvents.mediaItemId, mediaItemId),
        episodeMatches,
      ),
    )
    .limit(1);

  await db
    .insert(schema.watchEvents)
    .values({
      id: newId(),
      userId,
      mediaItemId,
      episodeId,
      watchedAt: occurredAt,
      isRewatch: Boolean(prior),
      progressPct: progressPct(event),
      source: 'jellyfin',
      sourceServerId: serverId,
      idempotencyKey: event.idempotency_key,
    })
    // S6.2: a retried batch is a no-op. The unique index on
    // (source_server_id, idempotency_key) is what makes that true even if two
    // flushes race.
    .onConflictDoNothing({
      target: [schema.watchEvents.sourceServerId, schema.watchEvents.idempotencyKey],
    });
}

function progressPct(event: IngestEvent): number | null {
  const { position_sec: position, runtime_sec: runtime } = event;
  if (!position || !runtime) return null;
  return Math.min(100, Math.round((position / runtime) * 100));
}

async function upsertSession(
  db: Database,
  args: {
    userId: string;
    serverId: string;
    mediaItemId: string;
    episodeId: string | null;
    event: IngestEvent;
    occurredAt: Date;
    now: Date;
  },
): Promise<void> {
  const { userId, serverId, mediaItemId, episodeId, event, occurredAt, now } =
    args;
  // S5.3 puts the TTL on the tracker's clock, not the sender's: a member's
  // server with a skewed clock would otherwise expire its own live sessions.
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await db
    .insert(schema.playbackSessions)
    .values({
      id: newId(),
      userId,
      serverId,
      jellyfinSessionId: sessionKey(event),
      mediaItemId,
      episodeId,
      positionSec: event.position_sec ?? null,
      runtimeSec: event.runtime_sec ?? null,
      isPaused: event.is_paused ?? false,
      device: event.device ?? null,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.playbackSessions.serverId,
        schema.playbackSessions.jellyfinSessionId,
      ],
      set: {
        mediaItemId,
        episodeId,
        positionSec: event.position_sec ?? null,
        runtimeSec: event.runtime_sec ?? null,
        isPaused: event.is_paused ?? false,
        device: event.device ?? null,
        updatedAt: occurredAt,
        expiresAt,
      },
    });
}

/**
 * S9 step 5. Never guess -- record it and let the owner resolve it on
 * /admin/unmatched. `raw` deliberately carries no path or filename (S6.3.3).
 */
async function recordUnmatched(
  db: Database,
  serverId: string,
  item: IngestItem,
  now: Date,
): Promise<void> {
  await db
    .insert(schema.unmatchedItems)
    .values({
      id: newId(),
      serverId,
      jellyfinItemId: item.jellyfin_item_id,
      raw: {
        item_type: item.item_type,
        name: item.name,
        production_year: item.production_year ?? null,
        series_name: item.series_name ?? null,
        season: item.season ?? null,
        episode: item.episode ?? null,
        provider_ids: item.provider_ids,
        series_provider_ids: item.series_provider_ids,
      },
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.unmatchedItems.serverId,
        schema.unmatchedItems.jellyfinItemId,
      ],
      set: { lastSeenAt: now, raw: sql.raw('excluded.raw') },
    });
}
