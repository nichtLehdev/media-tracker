import type {
  ExternalSource,
  TmdbFindResult,
  TmdbMovie,
  TmdbSearchResponse,
  TmdbSeason,
  TmdbShow,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'TmdbError';
  }
}

/** A 404 from TMDB is a real answer ("no such id"), not a failure. */
export class TmdbNotFoundError extends TmdbError {}

export interface TmdbClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Retries on 429 and 5xx. */
  maxRetries?: number;
  timeoutMs?: number;
}

export class TmdbClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  /** v4 read tokens are JWTs and go in the Authorization header. */
  private readonly usesBearer: boolean;

  constructor(options: TmdbClientOptions) {
    if (!options.apiKey) throw new Error('TMDB_API_KEY is not set');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.usesBearer = options.apiKey.startsWith('eyJ');
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    if (!this.usesBearer) url.searchParams.set('api_key', this.apiKey);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.usesBearer) headers.authorization = `Bearer ${this.apiKey}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.status === 404) {
          throw new TmdbNotFoundError('not found', 404, path);
        }
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? '1');
          await sleep(Math.min(retryAfter, 10) * 1000);
          continue;
        }
        if (res.status >= 500) {
          lastError = new TmdbError(`upstream ${res.status}`, res.status, path);
          await sleep(2 ** attempt * 250);
          continue;
        }
        if (!res.ok) {
          throw new TmdbError(`tmdb ${res.status}`, res.status, path);
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof TmdbNotFoundError) throw err;
        if (err instanceof TmdbError && err.status < 500) throw err;
        lastError = err;
        if (attempt < this.maxRetries) await sleep(2 ** attempt * 250);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new TmdbError('tmdb request failed', 0, path);
  }

  movie(tmdbId: number): Promise<TmdbMovie> {
    return this.get<TmdbMovie>(`/movie/${tmdbId}`);
  }

  show(tmdbId: number): Promise<TmdbShow> {
    return this.get<TmdbShow>(`/tv/${tmdbId}`, {
      append_to_response: 'external_ids',
    });
  }

  season(showTmdbId: number, season: number): Promise<TmdbSeason> {
    return this.get<TmdbSeason>(`/tv/${showTmdbId}/season/${season}`);
  }

  findByExternalId(
    externalId: string,
    source: ExternalSource,
  ): Promise<TmdbFindResult> {
    return this.get<TmdbFindResult>(`/find/${encodeURIComponent(externalId)}`, {
      external_source: source,
    });
  }

  searchMovie(query: string, year?: number): Promise<TmdbSearchResponse<TmdbMovie>> {
    return this.get<TmdbSearchResponse<TmdbMovie>>('/search/movie', {
      query,
      year,
      include_adult: 'false',
    });
  }

  searchShow(query: string, year?: number): Promise<TmdbSearchResponse<TmdbShow>> {
    return this.get<TmdbSearchResponse<TmdbShow>>('/search/tv', {
      query,
      first_air_date_year: year,
      include_adult: 'false',
    });
  }
}

export function posterUrl(
  posterPath: string | null | undefined,
  size: 'w185' | 'w342' | 'w500' | 'original' = 'w342',
): string | null {
  return posterPath ? `${TMDB_IMAGE_BASE}/${size}${posterPath}` : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
