import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { MediaProfile } from '@media-tracker/contracts';
import { episodes, mediaItems } from './media.js';
import { servers, users } from './identity.js';

/**
 * S5.4. Availability for a member is the union across all their linked
 * servers: an item is available if any row exists.
 */
export const libraryEntries = pgTable(
  'library_entries',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    serverId: uuid()
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    mediaItemId: uuid()
      .notNull()
      .references(() => mediaItems.id),
    episodeId: uuid().references(() => episodes.id),
    /** Needed to resolve incremental delete events, which carry only this id. */
    jellyfinItemId: text().notNull(),

    // technical profile (S7.7); langs are ISO 639-1 or the literal 'und'
    audioLangs: text().array().notNull().default(sql`'{}'`),
    subtitleLangs: text().array().notNull().default(sql`'{}'`),
    videoHeight: integer(),
    videoRange: text(),
    mediaProfile: jsonb().$type<MediaProfile>(),
    profileSyncedAt: timestamp({ withTimezone: true }),

    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastConfirmedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    // A primary key cannot contain an expression in PostgreSQL, hence the
    // surrogate id plus these two unique indexes.
    //
    // S5.4 writes this one as (server_id, jellyfin_item_id). That cannot hold
    // on a server with more than one member: S7.4 sends the library once per
    // local Jellyfin user, so the same item id arrives once per member and the
    // second insert collides -- on LarsFlix, which is the entire reason C2
    // exists. Scoped by user instead. Removals still resolve without
    // metadata, because a delta carries jellyfin_user_id (S6.3.1).
    uniqueIndex('library_entries_identity').on(
      t.serverId,
      t.userId,
      t.jellyfinItemId,
    ),
    uniqueIndex('library_entries_logical').on(
      t.userId,
      t.serverId,
      t.mediaItemId,
      sql`COALESCE(episode_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index('library_entries_media_item_id_index').on(t.mediaItemId),
    index('library_entries_audio_langs_index').using('gin', t.audioLangs),
    index('library_entries_subtitle_langs_index').using('gin', t.subtitleLangs),
  ],
);

/** Items the plugin reported that could not be matched to TMDB (S9). */
export const unmatchedItems = pgTable(
  'unmatched_items',
  {
    id: uuid().primaryKey(),
    serverId: uuid()
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    jellyfinItemId: text().notNull(),
    /** Name, year, provider ids. Never paths. */
    raw: jsonb().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedMediaItemId: uuid().references(() => mediaItems.id),
  },
  (t) => [
    uniqueIndex('unmatched_items_server_id_jellyfin_item_id_unique').on(
      t.serverId,
      t.jellyfinItemId,
    ),
  ],
);

/**
 * S7.6, the mass-removal safety valve.
 *
 * Jellyfin fires ItemRemoved when a scan finds files missing, and "missing"
 * includes "the network mount dropped". Applying such a batch deletes a
 * member's entire library and turns their availability red across every
 * screening. Removal batches over the threshold land here instead of being
 * applied, and wait for the owner to press Apply.
 *
 * The same guard covers deltas and snapshot reconciliation. Additions are
 * never quarantined -- a false-positive addition is harmless.
 */
export const librarySyncQuarantine = pgTable(
  'library_sync_quarantine',
  {
    id: uuid().primaryKey(),
    serverId: uuid()
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** The library_entries rows the sender proposed to delete. */
    entryIds: uuid().array().notNull(),
    entryCount: integer().notNull(),
    /** Total entries for this (user, server) when the batch was proposed. */
    libraryCount: integer().notNull(),
    /**
     * Hash of the sorted entry ids. This is what lets occurrences count
     * repeats of the *same* removal set rather than three unrelated flaps.
     */
    fingerprint: text().notNull(),
    occurrences: smallint().notNull().default(1),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    resolution: text(),
  },
  (t) => [
    check(
      'library_sync_quarantine_resolution_check',
      sql`${t.resolution} IN ('applied','dismissed','auto_applied')`,
    ),
    // Occurrence counting looks up the open row for this fingerprint; there
    // must never be two open rows for the same proposed removal set.
    uniqueIndex('library_sync_quarantine_open_fingerprint')
      .on(t.serverId, t.userId, t.fingerprint)
      .where(sql`resolved_at IS NULL`),
    index('library_sync_quarantine_pending')
      .on(t.serverId)
      .where(sql`resolved_at IS NULL`),
  ],
);

/**
 * Not in §5. §6.3.2 hands out a `sync_id` at `start` and requires `finish` to
 * know when the sync began, so the run needs a row of its own.
 *
 * The state matters as much as the timestamps: §6.3.2 is explicit that a sync
 * which never reaches `finish` must not delete anything, because a crashed
 * snapshot would otherwise wipe a member's library.
 */
export const librarySyncs = pgTable(
  'library_syncs',
  {
    id: uuid().primaryKey(),
    serverId: uuid()
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Kept for the owner's UI: which Jellyfin account this run covered. */
    jellyfinUserId: text().notNull(),
    estimatedCount: integer(),
    state: text().notNull().default('open'),
    itemsSeen: integer().notNull().default(0),
    unmatchedCount: integer().notNull().default(0),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check(
      'library_syncs_state_check',
      sql`${t.state} IN ('open','finished','abandoned')`,
    ),
    index('library_syncs_open')
      .on(t.serverId, t.userId)
      .where(sql`state = 'open'`),
  ],
);
