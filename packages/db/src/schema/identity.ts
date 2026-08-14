import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** S5.1 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey(),
    discordId: text().notNull(),
    displayName: text().notNull(),
    avatarUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

    // privacy (S15)
    announceWatches: boolean().notNull().default(true),
    historyVisibility: text().notNull().default('members'),
    nowplayingVisibility: text().notNull().default('members'),
  },
  (t) => [
    unique('users_discord_id_unique').on(t.discordId),
    check(
      'users_history_visibility_check',
      sql`${t.historyVisibility} IN ('members','private')`,
    ),
    check(
      'users_nowplaying_visibility_check',
      sql`${t.nowplayingVisibility} IN ('members','private')`,
    ),
  ],
);

export const servers = pgTable('servers', {
  id: uuid().primaryKey(),
  ownerUserId: uuid()
    .notNull()
    .references(() => users.id),
  /** Owner-chosen, e.g. "LarsFlix". */
  name: text().notNull(),
  /** argon2id of the bearer token. The token itself is never stored. */
  secretHash: text().notNull(),
  pluginVersion: text(),
  jellyfinVersion: text(),
  lastSeenAt: timestamp({ withTimezone: true }),
  revokedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * A Jellyfin account on one server, optionally linked to a tracker user.
 *
 * Credentials belong to the server, not the user (C2), so identity resolution
 * happens here: ingest carries a raw jellyfin_user_id and the tracker maps it
 * through this table. Events for anything other than link_state='linked' are
 * dropped -- but the row is still upserted, so the account shows up in the
 * owner's linking UI.
 */
export const serverAccounts = pgTable(
  'server_accounts',
  {
    serverId: uuid()
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    jellyfinUserId: text().notNull(),
    /** Reported by the plugin, for the owner's linking UI. */
    jellyfinUsername: text(),
    userId: uuid().references(() => users.id),
    linkState: text().notNull().default('unlinked'),
    linkedAt: timestamp({ withTimezone: true }),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.jellyfinUserId] }),
    check(
      'server_accounts_link_state_check',
      sql`${t.linkState} IN ('unlinked','pending','linked','rejected')`,
    ),
    index('server_accounts_user_id_index')
      .on(t.userId)
      .where(sql`link_state = 'linked'`),
  ],
);

/**
 * Not in the spec's DDL but required by S6.1: the owner generates a one-time
 * code on the website and pastes it into the plugin. Single-use, 15 minutes.
 *
 * The code is stored as a SHA-256 hash and looked up by hash, so a database
 * read does not hand out live registration codes. A code is only 40 bits of
 * entropy, so the register endpoint is rate limited too.
 */
export const registrationCodes = pgTable(
  'registration_codes',
  {
    id: uuid().primaryKey(),
    codeHash: text().notNull(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    serverId: uuid().references(() => servers.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('registration_codes_code_hash_unique').on(t.codeHash)],
);
