import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { episodes, mediaItems } from './media.js';
import { servers, users } from './identity.js';

/**
 * S5.3. Append-only, and the source of truth for everything historical.
 *
 * Jellyfin keeps only PlayCount and LastPlayedDate -- it has no history table
 * -- so this cannot be reconstructed from Jellyfin if lost. Back it up.
 */
export const watchEvents = pgTable(
  'watch_events',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    mediaItemId: uuid()
      .notNull()
      .references(() => mediaItems.id),
    /** Null for movies. */
    episodeId: uuid().references(() => episodes.id),
    watchedAt: timestamp({ withTimezone: true }).notNull(),
    /** Set by the importer when the source had no real per-play timestamp. */
    watchedAtIsApproximate: boolean().notNull().default(false),
    /** Computed at insert: a prior row exists for the same (user, item, ep). */
    isRewatch: boolean().notNull().default(false),
    progressPct: smallint(),
    source: text().notNull(),
    sourceServerId: uuid().references(() => servers.id),
    idempotencyKey: text(),
    announced: boolean().notNull().default(false),
    announceSuppressed: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'watch_events_source_check',
      sql`${t.source} IN ('jellyfin','import_trakt','import_simkl','manual')`,
    ),
    unique('watch_events_source_server_id_idempotency_key_unique').on(
      t.sourceServerId,
      t.idempotencyKey,
    ),
    index('watch_events_user_id_watched_at_index').on(
      t.userId,
      t.watchedAt.desc(),
    ),
    index('watch_events_user_id_media_item_id_index').on(
      t.userId,
      t.mediaItemId,
    ),
    index('watch_events_user_id_episode_id_index').on(t.userId, t.episodeId),
  ],
);

/**
 * Upserted on every progress heartbeat with expires_at = now() + 2 minutes.
 * A periodic job deletes expired rows -- that, not a stop event, is what
 * cleans up when a member's server drops offline mid-episode.
 */
export const playbackSessions = pgTable(
  'playback_sessions',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    serverId: uuid()
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    jellyfinSessionId: text().notNull(),
    mediaItemId: uuid()
      .notNull()
      .references(() => mediaItems.id),
    episodeId: uuid().references(() => episodes.id),
    positionSec: integer(),
    runtimeSec: integer(),
    isPaused: boolean().notNull().default(false),
    device: text(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    unique('playback_sessions_server_id_jellyfin_session_id_unique').on(
      t.serverId,
      t.jellyfinSessionId,
    ),
    index('playback_sessions_expires_at_index').on(t.expiresAt),
  ],
);

/**
 * Not in §5. §19 open question 5 asked whether sessions should be archived or
 * stay ephemeral; the answer is archive, because the retrofit is impossible --
 * once a session is deleted the time it represents is gone, and "hours watched
 * per week" could then only ever cover the period after the decision.
 *
 * One row per finished session, written by the expiry job as it drains
 * `playback_sessions`. Deliberately not the heartbeats: position updates land
 * every 30 seconds per session and almost none of that survives aggregation.
 *
 * The id is the expired session's own id, so re-running the job cannot double
 * count. The server reference does not cascade, matching `watch_events`:
 * disowning a server must not silently rewrite a member's history (§8).
 */
export const playbackSessionArchive = pgTable(
  'playback_session_archive',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    serverId: uuid()
      .notNull()
      .references(() => servers.id),
    mediaItemId: uuid()
      .notNull()
      .references(() => mediaItems.id),
    episodeId: uuid().references(() => episodes.id),
    device: text(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** Last heartbeat received, not `expires_at`: the two-minute TTL is slack. */
    endedAt: timestamp({ withTimezone: true }).notNull(),
    /** Final reported position. The honest measure of what was watched. */
    positionSec: integer(),
    runtimeSec: integer(),
    archivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('playback_session_archive_user_id_started_at_index').on(
      t.userId,
      t.startedAt.desc(),
    ),
  ],
);
