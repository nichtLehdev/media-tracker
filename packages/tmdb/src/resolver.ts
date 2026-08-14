import { and, eq, newId, schema, sql, type Database } from '@media-tracker/db';
import type { ProviderIds } from '@media-tracker/contracts';
import { TmdbClient, TmdbNotFoundError } from './client.js';
import { titlesMatch, yearsMatch } from './normalise.js';

/**
 * Movies do not change; shows gain episodes. S9 asks for 30 days, dropping to
 * 7 for shows still airing -- but S5.2 has nowhere to record airing status, so
 * every show refreshes on the 7-day cadence instead. That is the conservative
 * direction: episode_count stays correct for progress, at the cost of one TMDB
 * call per show per week.
 */
const MOVIE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const SHOW_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export type UnmatchedReason =
  | 'no_provider_ids'
  | 'no_series_match'
  | 'no_episode_match'
  | 'ambiguous_title'
  | 'tmdb_error';

export type Resolution =
  | { status: 'matched'; mediaItemId: string; episodeId: string | null }
  | { status: 'unmatched'; reason: UnmatchedReason };

/** The overlapping subset of IngestItem and LibraryItem that S9 needs. */
export interface ResolveInput {
  item_type: 'Movie' | 'Episode';
  name: string;
  production_year?: number | null;
  series_name?: string | null;
  season?: number | null;
  episode?: number | null;
  provider_ids?: ProviderIds;
  series_provider_ids?: ProviderIds;
}

const toInt = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const yearOf = (date: string | null | undefined): number | null => {
  if (!date) return null;
  const y = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
};

export class MediaResolver {
  /**
   * Collapses concurrent work on the same key. A snapshot chunk of 500
   * episodes of one show would otherwise fire 500 identical show fetches.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Database,
    private readonly tmdb: TmdbClient,
  ) {}

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async resolve(input: ResolveInput): Promise<Resolution> {
    try {
      return input.item_type === 'Episode'
        ? await this.resolveEpisode(input)
        : await this.resolveMovie(input);
    } catch (err) {
      if (err instanceof TmdbNotFoundError) {
        return { status: 'unmatched', reason: 'no_provider_ids' };
      }
      throw err;
    }
  }

  // --- movies -------------------------------------------------------------

  private async resolveMovie(input: ResolveInput): Promise<Resolution> {
    const ids = input.provider_ids ?? {};

    // 1. direct TMDB id
    const tmdbId = toInt(ids.Tmdb);
    if (tmdbId) {
      return {
        status: 'matched',
        mediaItemId: await this.getOrCreateMovie(tmdbId),
        episodeId: null,
      };
    }

    // 2. external id -> /find
    for (const [value, source] of [
      [ids.Imdb, 'imdb_id'],
      [ids.Tvdb, 'tvdb_id'],
    ] as const) {
      if (!value) continue;
      const found = await this.tmdb.findByExternalId(value, source);
      const hit = found.movie_results[0];
      if (hit) {
        return {
          status: 'matched',
          mediaItemId: await this.getOrCreateMovie(hit.id),
          episodeId: null,
        };
      }
    }

    // 4. title + year, exact normalised match only
    const year = input.production_year ?? undefined;
    const search = await this.tmdb.searchMovie(input.name, year);
    const candidates = search.results.filter(
      (r) =>
        (titlesMatch(r.title, input.name) ||
          titlesMatch(r.original_title ?? '', input.name)) &&
        yearsMatch(yearOf(r.release_date), year),
    );
    if (candidates.length === 1) {
      return {
        status: 'matched',
        mediaItemId: await this.getOrCreateMovie(candidates[0]!.id),
        episodeId: null,
      };
    }

    // 5. do not guess
    return {
      status: 'unmatched',
      reason: candidates.length > 1 ? 'ambiguous_title' : 'no_provider_ids',
    };
  }

  // --- episodes -----------------------------------------------------------

  private async resolveEpisode(input: ResolveInput): Promise<Resolution> {
    const showTmdbId = await this.resolveShowTmdbId(input);
    if (!showTmdbId) {
      return { status: 'unmatched', reason: 'no_series_match' };
    }

    const showId = await this.getOrCreateShow(showTmdbId);
    const season = input.season;
    const number = input.episode;
    if (season == null || number == null) {
      return { status: 'unmatched', reason: 'no_episode_match' };
    }

    const episodeId = await this.ensureEpisode(
      showId,
      showTmdbId,
      season,
      number,
    );
    if (!episodeId) {
      return { status: 'unmatched', reason: 'no_episode_match' };
    }
    return { status: 'matched', mediaItemId: showId, episodeId };
  }

  /**
   * S9 step 3: resolve the *series*, then match on season/episode numbers.
   * Episode-level TMDB ids are frequently missing in real libraries, and when
   * present they identify the episode rather than the show -- so they are not
   * a shortcut here.
   */
  private async resolveShowTmdbId(
    input: ResolveInput,
  ): Promise<number | undefined> {
    const seriesIds = input.series_provider_ids ?? {};

    const direct = toInt(seriesIds.Tmdb);
    if (direct) return direct;

    for (const [value, source] of [
      [seriesIds.Imdb, 'imdb_id'],
      [seriesIds.Tvdb, 'tvdb_id'],
    ] as const) {
      if (!value) continue;
      const found = await this.tmdb.findByExternalId(value, source);
      const hit = found.tv_results[0];
      if (hit) return hit.id;
    }

    // Episode-level TVDB ids do identify the episode, and /find returns the
    // show id alongside it.
    const epTvdb = (input.provider_ids ?? {}).Tvdb;
    if (epTvdb) {
      const found = await this.tmdb.findByExternalId(epTvdb, 'tvdb_id');
      const hit = found.tv_episode_results[0];
      if (hit?.show_id) return hit.show_id;
    }

    // Title fallback on the *series* name. The episode's production_year is
    // the episode's air year, not the series', so it is not a year filter.
    const seriesName = input.series_name;
    if (!seriesName) return undefined;
    const search = await this.tmdb.searchShow(seriesName);
    const candidates = search.results.filter(
      (r) =>
        titlesMatch(r.name, seriesName) ||
        titlesMatch(r.original_name ?? '', seriesName),
    );
    return candidates.length === 1 ? candidates[0]!.id : undefined;
  }

  // --- cache layer --------------------------------------------------------

  private async getOrCreateMovie(tmdbId: number): Promise<string> {
    return this.once(`movie:${tmdbId}`, async () => {
      const [existing] = await this.db
        .select({
          id: schema.mediaItems.id,
          refreshedAt: schema.mediaItems.metadataRefreshedAt,
        })
        .from(schema.mediaItems)
        .where(
          and(
            eq(schema.mediaItems.kind, 'movie'),
            eq(schema.mediaItems.tmdbId, tmdbId),
          ),
        )
        .limit(1);

      if (existing && !isStale(existing.refreshedAt, MOVIE_REFRESH_MS)) {
        return existing.id;
      }

      const movie = await this.tmdb.movie(tmdbId);
      const [row] = await this.db
        .insert(schema.mediaItems)
        .values({
          id: existing?.id ?? newId(),
          kind: 'movie',
          tmdbId: movie.id,
          imdbId: movie.imdb_id ?? null,
          title: movie.title,
          year: yearOf(movie.release_date),
          runtimeMin: movie.runtime ?? null,
          posterPath: movie.poster_path ?? null,
          overview: movie.overview ?? null,
          metadataRefreshedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.mediaItems.kind, schema.mediaItems.tmdbId],
          set: {
            imdbId: movie.imdb_id ?? null,
            title: movie.title,
            year: yearOf(movie.release_date),
            runtimeMin: movie.runtime ?? null,
            posterPath: movie.poster_path ?? null,
            overview: movie.overview ?? null,
            metadataRefreshedAt: new Date(),
          },
        })
        .returning({ id: schema.mediaItems.id });

      return row!.id;
    });
  }

  private async getOrCreateShow(tmdbId: number): Promise<string> {
    return this.once(`show:${tmdbId}`, async () => {
      const [existing] = await this.db
        .select({
          id: schema.mediaItems.id,
          refreshedAt: schema.mediaItems.metadataRefreshedAt,
        })
        .from(schema.mediaItems)
        .where(
          and(
            eq(schema.mediaItems.kind, 'show'),
            eq(schema.mediaItems.tmdbId, tmdbId),
          ),
        )
        .limit(1);

      if (existing && !isStale(existing.refreshedAt, SHOW_REFRESH_MS)) {
        return existing.id;
      }

      const show = await this.tmdb.show(tmdbId);
      const [row] = await this.db
        .insert(schema.mediaItems)
        .values({
          id: existing?.id ?? newId(),
          kind: 'show',
          tmdbId: show.id,
          imdbId: show.external_ids?.imdb_id ?? null,
          tvdbId: show.external_ids?.tvdb_id ?? null,
          title: show.name,
          year: yearOf(show.first_air_date),
          runtimeMin: show.episode_run_time?.[0] ?? null,
          posterPath: show.poster_path ?? null,
          overview: show.overview ?? null,
          episodeCount: show.number_of_episodes ?? null,
          metadataRefreshedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.mediaItems.kind, schema.mediaItems.tmdbId],
          set: {
            imdbId: show.external_ids?.imdb_id ?? null,
            tvdbId: show.external_ids?.tvdb_id ?? null,
            title: show.name,
            year: yearOf(show.first_air_date),
            runtimeMin: show.episode_run_time?.[0] ?? null,
            posterPath: show.poster_path ?? null,
            overview: show.overview ?? null,
            episodeCount: show.number_of_episodes ?? null,
            metadataRefreshedAt: new Date(),
          },
        })
        .returning({ id: schema.mediaItems.id });

      return row!.id;
    });
  }

  private async ensureEpisode(
    showId: string,
    showTmdbId: number,
    season: number,
    number: number,
  ): Promise<string | null> {
    const [hit] = await this.db
      .select({ id: schema.episodes.id })
      .from(schema.episodes)
      .where(
        and(
          eq(schema.episodes.showId, showId),
          eq(schema.episodes.season, season),
          eq(schema.episodes.number, number),
        ),
      )
      .limit(1);
    if (hit) return hit.id;

    // Miss: pull the whole season in one call rather than one per episode.
    await this.once(`season:${showTmdbId}:${season}`, async () => {
      let fetched;
      try {
        fetched = await this.tmdb.season(showTmdbId, season);
      } catch (err) {
        if (err instanceof TmdbNotFoundError) return;
        throw err;
      }
      if (!fetched.episodes?.length) return;

      await this.db
        .insert(schema.episodes)
        .values(
          fetched.episodes.map((ep) => ({
            id: newId(),
            showId,
            season: ep.season_number ?? season,
            number: ep.episode_number,
            tmdbId: ep.id,
            title: ep.name ?? null,
            airDate: ep.air_date || null,
            runtimeMin: ep.runtime ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [
            schema.episodes.showId,
            schema.episodes.season,
            schema.episodes.number,
          ],
          set: {
            title: sqlExcluded('title'),
            airDate: sqlExcluded('air_date'),
            runtimeMin: sqlExcluded('runtime_min'),
            tmdbId: sqlExcluded('tmdb_id'),
          },
        });
    });

    const [retry] = await this.db
      .select({ id: schema.episodes.id })
      .from(schema.episodes)
      .where(
        and(
          eq(schema.episodes.showId, showId),
          eq(schema.episodes.season, season),
          eq(schema.episodes.number, number),
        ),
      )
      .limit(1);
    return retry?.id ?? null;
  }
}

function isStale(refreshedAt: Date | null, maxAgeMs: number): boolean {
  if (!refreshedAt) return true;
  return Date.now() - refreshedAt.getTime() > maxAgeMs;
}

/** Postgres exposes the rejected row as `excluded` inside DO UPDATE. */
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);
