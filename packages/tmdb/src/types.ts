export interface TmdbMovie {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string | null;
  runtime?: number | null;
  poster_path?: string | null;
  overview?: string | null;
  imdb_id?: string | null;
}

export interface TmdbShow {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string | null;
  episode_run_time?: number[];
  poster_path?: string | null;
  overview?: string | null;
  number_of_episodes?: number | null;
  status?: string | null;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
  seasons?: Array<{
    season_number: number;
    episode_count?: number;
    air_date?: string | null;
  }>;
}

export interface TmdbEpisode {
  id: number;
  episode_number: number;
  season_number: number;
  name?: string | null;
  air_date?: string | null;
  runtime?: number | null;
}

export interface TmdbSeason {
  season_number: number;
  episodes: TmdbEpisode[];
}

export interface TmdbFindResult {
  movie_results: TmdbMovie[];
  tv_results: TmdbShow[];
  tv_episode_results: Array<TmdbEpisode & { show_id?: number }>;
}

export interface TmdbSearchResponse<T> {
  page: number;
  total_results: number;
  results: T[];
}

export type ExternalSource = 'imdb_id' | 'tvdb_id';
