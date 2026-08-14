import { sql } from 'drizzle-orm';
import {
  check,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * S5.2. The canonical entity, keyed on TMDB. Episodes live in `episodes`,
 * not here.
 */
export const mediaItems = pgTable(
  'media_items',
  {
    id: uuid().primaryKey(),
    kind: text().notNull(),
    tmdbId: integer().notNull(),
    imdbId: text(),
    tvdbId: integer(),
    title: text().notNull(),
    year: integer(),
    runtimeMin: integer(),
    posterPath: text(),
    overview: text(),
    /** Aired episodes, refreshed from TMDB; drives watch-status completion. */
    episodeCount: integer(),
    metadataRefreshedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check('media_items_kind_check', sql`${t.kind} IN ('movie','show')`),
    unique('media_items_kind_tmdb_id_unique').on(t.kind, t.tmdbId),
  ],
);

export const episodes = pgTable(
  'episodes',
  {
    id: uuid().primaryKey(),
    showId: uuid()
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    season: integer().notNull(),
    number: integer().notNull(),
    tmdbId: integer(),
    title: text(),
    airDate: date(),
    runtimeMin: integer(),
  },
  (t) => [
    unique('episodes_show_id_season_number_unique').on(
      t.showId,
      t.season,
      t.number,
    ),
  ],
);
