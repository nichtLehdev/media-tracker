# Media Tracker — Implementation Specification

A self-hosted, Trakt-like movie and series tracker for a Discord community whose members
each run their own Jellyfin instance.

**Audience:** an implementing engineer (human or Claude Code) with no prior context on this
project. Read sections 1–3 before writing any code; they contain the constraints that
explain most of the design decisions further down.

---

## 0. How to use this document

- Sections 1–5 are **binding**: architecture, trust model, and schema. Do not deviate
  without raising it.
- Sections 6–15 are **detailed design**: follow them, but flag anything that turns out to be
  wrong against the real Jellyfin/Jellyseerr APIs rather than silently improvising.
- Section 18 is the build order. Work milestone by milestone; each has acceptance criteria.
- Section 19 lists genuinely open questions. Ask before implementing anything that depends
  on them.

Conventions used below: `snake_case` for database identifiers, `camelCase` for TypeScript,
`PascalCase` for C#. All timestamps are `timestamptz` and stored in UTC. All IDs are UUIDv7
unless stated otherwise.

---

## 1. Product summary

### 1.1 What it does

- Tracks what each member watches, across **multiple independent Jellyfin servers**.
- Shows each member's library (= what is available on the Jellyfin servers they've linked),
  their current watch status, and their full watch history.
- Posts a message to a Discord channel when someone watches or rewatches something.
- Answers "who is watching what right now" for the Discord bot.
- Hosts "screenings": user-created scheduled events for a specific film or episode, with a
  readiness grid showing which participants already have it available, and a one-click
  request to that participant's own Jellyseerr/Overseerr instance if they don't.
- Imports historical watch data from Trakt and SIMKL, once, at signup.

### 1.2 Non-goals

- **No ongoing Trakt/SIMKL sync.** They are import sources only. Do not build a poller.
- **No transcoding, streaming, or media serving.** This app never touches media files.
- **No public/multi-tenant signup.** Access is limited to members of one Discord guild.
- **No mobile apps.** The website is a responsive PWA at most.

---

## 2. Architecture and trust model

### 2.1 Topology

```
  ┌────────────────────┐   push events + library  ┌──────────────────────┐
  │ Jellyfin server A  │ ───────────────────────► │                      │
  │  + tracker plugin  │ ◄─────────────────────── │   Tracker API        │
  └────────────────────┘   long-poll commands     │   (Next.js, VPS)     │
  ┌────────────────────┐                          │                      │
  │ Jellyfin server B  │ ◄──────────────────────► │          │           │
  │  + tracker plugin  │                          └──────────┼───────────┘
  └────────────────────┘                                     │
  ┌────────────────────┐                              ┌──────▼───────┐
  │ LarsFlix (shared,  │ ◄──────────────────────►     │  PostgreSQL  │
  │  many users)       │                              └──────┬───────┘
  └────────────────────┘                                     │
                                                     ┌───────▼────────┐
   Discord ◄── webhook posts ──────────────────────  │ Worker         │
   Discord bot ── REST ────────────────────────────► │ (pg-boss jobs) │
                                                     └────────────────┘
```

### 2.2 The three constraints that shape everything

**C1 — Member Jellyfin servers are not reachable from the tracker.**
They sit behind CGNAT, dynamic IPs, or no reverse proxy at all. The tracker can **never**
initiate a connection to a member's server. Every interaction is either a push from the
plugin, or a command the plugin picks up on its own long-poll. This is why library
inventory is pushed rather than pulled, and why section 13 exists in the form it does.

**C2 — One server can host many members.**
LarsFlix has several Discord members on it. Therefore credentials belong to the *server*,
not to a user. Identity resolution (Jellyfin user → tracker user) happens on the tracker
side, via an explicit linking flow (section 8). The ingest payload never asserts a tracker
identity; it carries a raw `jellyfin_user_id`, and the tracker maps it.

**C3 — The server owner is the trust boundary.**
Whoever operates a linked Jellyfin instance can fabricate watch events for any linked
member on that instance. This is accepted. The mitigations are: (a) tokens are scoped per
server, so a bad server can only affect its own linked members; (b) every derived row
carries `source_server_id`, so one server's data can be disowned wholesale; (c) linking a
Jellyfin account to a tracker account requires acceptance from *both* the server owner and
the member.

### 2.3 Data flow, watch event

1. Member finishes an episode on their own Jellyfin server.
2. Plugin observes `UserDataSaved` with `SaveReason = PlaybackFinished`, enqueues a local
   event with an `idempotency_key`.
3. Plugin flushes its queue to `POST /api/v1/ingest` with the server bearer token.
4. Tracker authenticates the server, maps `jellyfin_user_id` → `tracker_user_id` via
   `server_accounts`, resolves the media item via provider IDs, writes a `watch_events` row.
5. Tracker enqueues an announcement into a debounce batch (section 11).
6. Worker flushes the batch after the window closes and posts one Discord message.

---

## 3. Stack and repository layout

pnpm workspaces monorepo. Node 22, TypeScript strict mode everywhere.

```
media-tracker/
├─ apps/
│  ├─ web/            Next.js 15 (App Router) — website + all HTTP APIs
│  └─ worker/         Node process — pg-boss consumers (announcements, imports, seerr polls)
├─ packages/
│  ├─ db/             Drizzle schema, migrations, seed
│  ├─ contracts/      Zod schemas shared by web/worker; source of truth for wire formats
│  └─ tmdb/           TMDB client + caching layer
├─ plugin/            Jellyfin.Plugin.Tracker — .NET 8, built separately
├─ docker/            Compose file, Dockerfiles
└─ docs/              This document and ADRs
```

| Concern | Choice | Why |
|---|---|---|
| Web framework | Next.js 15 App Router | Existing familiarity; API routes and UI in one deploy |
| DB | PostgreSQL 16 | Already operated on this VPS |
| ORM | Drizzle | SQL-first; migrations are reviewable |
| Job queue | pg-boss | Postgres-backed — avoids introducing Redis |
| Auth | Auth.js v5, Discord provider only | Members are already in the guild |
| Validation | Zod, in `packages/contracts` | One definition for API + plugin contract tests |
| Discord announcements | Channel webhook, posted by the worker | No bot dependency for the core loop |
| Discord commands | Existing bot calls the tracker's bot API | Language-agnostic; see §6.4 |
| Plugin | .NET 8, Jellyfin 10.10 ABI | Jellyfin's plugin target |

**Note on the Discord bot:** the existing community bot already exists in its own repo.
This project does **not** rewrite it. Announcements go out via webhook from the worker;
slash commands are served by exposing a small REST surface (§6.4) that the existing bot
calls. Confirm the bot's language before assuming anything about its internals.

---

## 4. Configuration

All secrets via environment. No secrets in the repo, no defaults for security-relevant vars.

```bash
DATABASE_URL=postgres://...
AUTH_SECRET=                      # Auth.js
AUTH_DISCORD_ID=
AUTH_DISCORD_SECRET=
DISCORD_GUILD_ID=                 # allowlist: only members of this guild may sign in
DISCORD_ANNOUNCE_WEBHOOK_URL=
BOT_API_TOKEN=                    # shared secret for §6.4
TMDB_API_KEY=
SECRETS_ENC_KEY=                  # 32-byte base64; AES-256-GCM for stored Seerr API keys
DEFAULT_SEERR_BASE_URL=           # Lars's public Jellyseerr, used as fallback
DEFAULT_SEERR_API_KEY=
PUBLIC_BASE_URL=https://tracker.lehdev.de
```

---

## 5. Data model

Full DDL. Indexes listed are the ones required for the query patterns in this document; add
more only with an EXPLAIN to justify them.

### 5.1 Identity

```sql
CREATE TABLE users (
  id                uuid PRIMARY KEY,
  discord_id        text NOT NULL UNIQUE,
  display_name      text NOT NULL,
  avatar_url        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- privacy (see §15)
  announce_watches  boolean NOT NULL DEFAULT true,
  history_visibility    text NOT NULL DEFAULT 'members'
                        CHECK (history_visibility IN ('members','private')),
  nowplaying_visibility text NOT NULL DEFAULT 'members'
                        CHECK (nowplaying_visibility IN ('members','private'))
);

CREATE TABLE servers (
  id              uuid PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  name            text NOT NULL,              -- "LarsFlix", owner-chosen
  secret_hash     text NOT NULL,              -- argon2id of the bearer token
  plugin_version  text,
  jellyfin_version text,
  last_seen_at    timestamptz,
  revoked_at      timestamptz
);

-- A Jellyfin account on one server, optionally linked to a tracker user.
CREATE TABLE server_accounts (
  server_id         uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  jellyfin_user_id  text NOT NULL,
  jellyfin_username text,                     -- reported by plugin, for the linking UI
  user_id           uuid REFERENCES users(id),
  link_state        text NOT NULL DEFAULT 'unlinked'
                    CHECK (link_state IN ('unlinked','pending','linked','rejected')),
  linked_at         timestamptz,
  PRIMARY KEY (server_id, jellyfin_user_id)
);
CREATE INDEX ON server_accounts (user_id) WHERE link_state = 'linked';
```

### 5.2 Media catalogue

`media_items` is the canonical entity, keyed on TMDB. Episodes are separate rows in
`episodes`, not in `media_items`.

```sql
CREATE TABLE media_items (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('movie','show')),
  tmdb_id      integer NOT NULL,
  imdb_id      text,
  tvdb_id      integer,
  title        text NOT NULL,
  year         integer,
  runtime_min  integer,
  poster_path  text,
  overview     text,
  episode_count integer,          -- aired episodes, refreshed from TMDB
  metadata_refreshed_at timestamptz,
  UNIQUE (kind, tmdb_id)
);

CREATE TABLE episodes (
  id           uuid PRIMARY KEY,
  show_id      uuid NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  season       integer NOT NULL,
  number       integer NOT NULL,
  tmdb_id      integer,
  title        text,
  air_date     date,
  runtime_min  integer,
  UNIQUE (show_id, season, number)
);
```

### 5.3 Watching

`watch_events` is append-only and is the source of truth for everything historical.
Jellyfin itself only keeps `PlayCount` and `LastPlayedDate` — it has no history table — so
this table cannot be reconstructed from Jellyfin if lost. Back it up.

```sql
CREATE TABLE watch_events (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  media_item_id    uuid NOT NULL REFERENCES media_items(id),
  episode_id       uuid REFERENCES episodes(id),      -- null for movies
  watched_at       timestamptz NOT NULL,
  watched_at_is_approximate boolean NOT NULL DEFAULT false,  -- set by importer
  is_rewatch       boolean NOT NULL DEFAULT false,
  progress_pct     smallint,
  source           text NOT NULL CHECK (source IN ('jellyfin','import_trakt','import_simkl','manual')),
  source_server_id uuid REFERENCES servers(id),
  idempotency_key  text,
  announced        boolean NOT NULL DEFAULT false,
  announce_suppressed boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_server_id, idempotency_key)
);
CREATE INDEX ON watch_events (user_id, watched_at DESC);
CREATE INDEX ON watch_events (user_id, media_item_id);
CREATE INDEX ON watch_events (user_id, episode_id);
```

`is_rewatch` is computed at insert time: true if a prior `watch_events` row exists for the
same `(user_id, media_item_id, episode_id)`.

```sql
CREATE TABLE playback_sessions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  server_id        uuid NOT NULL REFERENCES servers(id),
  jellyfin_session_id text NOT NULL,
  media_item_id    uuid NOT NULL REFERENCES media_items(id),
  episode_id       uuid REFERENCES episodes(id),
  position_sec     integer,
  runtime_sec      integer,
  is_paused        boolean NOT NULL DEFAULT false,
  device           text,
  started_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  UNIQUE (server_id, jellyfin_session_id)
);
CREATE INDEX ON playback_sessions (expires_at);
```

Sessions are upserted on every progress heartbeat with
`expires_at = now() + interval '2 minutes'`. A periodic job deletes expired rows. This is
what cleans up dangling sessions when a member's server drops offline mid-episode — do not
rely on receiving a stop event.

### 5.4 Library

```sql
CREATE TABLE library_entries (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  server_id       uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  media_item_id   uuid NOT NULL REFERENCES media_items(id),
  episode_id      uuid REFERENCES episodes(id),
  jellyfin_item_id text NOT NULL,        -- needed to resolve incremental delete events
  -- technical profile, see §7.7
  audio_langs     text[] NOT NULL DEFAULT '{}',   -- normalised ISO 639-1
  subtitle_langs  text[] NOT NULL DEFAULT '{}',
  video_height    integer,
  video_range     text,                   -- 'SDR' | 'HDR10' | 'HDR10+' | 'DV' | 'HLG'
  media_profile   jsonb,                  -- full detail, see §7.7
  profile_synced_at timestamptz,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX library_entries_identity
  ON library_entries (server_id, jellyfin_item_id);
CREATE UNIQUE INDEX library_entries_logical
  ON library_entries (user_id, server_id, media_item_id,
                      COALESCE(episode_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX ON library_entries (media_item_id);
CREATE INDEX ON library_entries USING gin (audio_langs);
CREATE INDEX ON library_entries USING gin (subtitle_langs);
```

A primary key cannot contain an expression in PostgreSQL, hence the surrogate `id` plus the
two unique indexes: one on Jellyfin's own item id (so incremental delete events can find
the row without re-resolving metadata) and one on the logical identity.

Availability for a member is the **union across all their linked servers**: an item is
available if any row exists. Removals arrive two ways — incremental delete events for
responsiveness, and full-snapshot reconciliation as the authority. See §7.4 for why both
are needed and §7.6 for the safety valve that stops a broken mount from wiping a library.

```sql
-- Items the plugin reported that could not be matched to TMDB.
CREATE TABLE unmatched_items (
  id            uuid PRIMARY KEY,
  server_id     uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  jellyfin_item_id text NOT NULL,
  raw           jsonb NOT NULL,        -- name, year, provider ids, path-free
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_media_item_id uuid REFERENCES media_items(id),
  UNIQUE (server_id, jellyfin_item_id)
);
```

### 5.5 Screenings

```sql
CREATE TABLE screenings (
  id             uuid PRIMARY KEY,
  created_by     uuid NOT NULL REFERENCES users(id),
  media_item_id  uuid NOT NULL REFERENCES media_items(id),
  episode_id     uuid REFERENCES episodes(id),
  starts_at      timestamptz NOT NULL,
  title          text,
  notes          text,
  discord_message_id text,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE screening_participants (
  screening_id uuid NOT NULL REFERENCES screenings(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  rsvp         text NOT NULL DEFAULT 'yes' CHECK (rsvp IN ('yes','no','maybe')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screening_id, user_id)
);
```

Readiness is **not** stored — it is computed live from `library_entries` when the page
renders. Caching it creates a stale-readiness bug the first time someone downloads the film
an hour before the screening.

### 5.6 Seerr and the command channel

```sql
CREATE TABLE seerr_configs (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_url      text NOT NULL,
  api_key_enc   bytea NOT NULL,          -- AES-256-GCM, key from SECRETS_ENC_KEY
  api_key_nonce bytea NOT NULL,
  routing       text NOT NULL CHECK (routing IN ('direct','relay')),
  relay_server_id uuid REFERENCES servers(id),   -- required when routing = 'relay'
  flavour       text CHECK (flavour IN ('jellyseerr','overseerr')),
  verified_at   timestamptz,
  last_error    text
);

CREATE TABLE media_requests (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  screening_id   uuid REFERENCES screenings(id) ON DELETE SET NULL,
  media_item_id  uuid NOT NULL REFERENCES media_items(id),
  season         integer,
  remote_request_id text,
  status         text NOT NULL DEFAULT 'submitting'
                 CHECK (status IN ('submitting','pending','approved','available','failed','declined')),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_commands (
  id           uuid PRIMARY KEY,
  server_id    uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind         text NOT NULL,             -- 'seerr.request' | 'seerr.status' | 'library.resync'
  payload      jsonb NOT NULL,
  state        text NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','claimed','done','failed','expired')),
  claimed_at   timestamptz,
  result       jsonb,
  error        text,
  attempts     smallint NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON plugin_commands (server_id, state) WHERE state = 'queued';
```

### 5.7 Announcements and imports

```sql
CREATE TABLE announcement_batches (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  media_item_id uuid NOT NULL REFERENCES media_items(id),
  window_ends_at timestamptz NOT NULL,
  sent_at       timestamptz,
  UNIQUE (user_id, media_item_id) WHERE sent_at IS NULL
);

CREATE TABLE import_jobs (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  provider     text NOT NULL CHECK (provider IN ('trakt','simkl')),
  state        text NOT NULL DEFAULT 'queued',
  stats        jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
```

Note the partial unique index on `announcement_batches`: at most one open batch per
(user, title). PostgreSQL syntax for that is
`CREATE UNIQUE INDEX ... ON announcement_batches (user_id, media_item_id) WHERE sent_at IS NULL;`
— write it as a separate statement, the inline form above is shorthand.

---

## 6. HTTP API

All plugin-facing endpoints live under `/api/v1/`. All request and response bodies are
defined as Zod schemas in `packages/contracts` and are the single source of truth; the C#
DTOs must be kept in sync manually, and a contract test in the plugin repo should assert a
round-trip against a recorded fixture.

### 6.1 Server registration

The owner generates a one-time registration code on the website, then pastes it into the
plugin's config page.

```
POST /api/v1/servers/register
Content-Type: application/json

{ "registration_code": "ABCD-EFGH", "name": "LarsFlix",
  "jellyfin_version": "10.10.3", "plugin_version": "1.0.0" }

200 { "server_id": "uuid", "server_secret": "opaque-64-char" }
```

The secret is returned exactly once and stored argon2id-hashed. Registration codes are
single-use and expire in 15 minutes.

### 6.2 Ingest

```
POST /api/v1/ingest
Authorization: Bearer <server_secret>
X-Plugin-Version: 1.0.0

{
  "events": [
    {
      "idempotency_key": "uuid",
      "jellyfin_user_id": "f1c2...",
      "type": "playback.start | playback.progress | playback.stop | item.played",
      "occurred_at": "2026-08-13T20:11:04Z",
      "session_id": "abc123",
      "item": {
        "jellyfin_item_id": "8d9...",
        "item_type": "Movie | Episode",
        "name": "Rogue One",
        "production_year": 2016,
        "series_name": "Andor",
        "season": 1,
        "episode": 3,
        "provider_ids": { "Tmdb": "1396", "Imdb": "tt0903747", "Tvdb": "81189" },
        "series_provider_ids": { "Tmdb": "83867" }
      },
      "position_sec": 812,
      "runtime_sec": 2610,
      "is_paused": false,
      "device": "webOS"
    }
  ]
}

202 { "accepted": 1, "rejected": 0, "unmatched": 0, "errors": [] }
```

Rules:

- **Batched.** Up to 200 events per request. Partial success is allowed and reported per
  event; the plugin must only drop events the server explicitly accepted or rejected as
  permanent.
- **Idempotent.** `(source_server_id, idempotency_key)` is unique. A retried batch is a
  no-op returning 202.
- **Never trusts identity.** `jellyfin_user_id` is looked up in `server_accounts` for this
  server. If it is unlinked or the link is pending, the event is dropped with
  `rejected: unlinked_account` — but the account row is upserted so it appears in the
  owner's linking UI.
- **Rejects unknown servers**: 401 on bad or revoked secret.
- Rate limit: 60 requests/minute per server.

Event semantics:

| type | Jellyfin trigger | Effect |
|---|---|---|
| `playback.start` | `ISessionManager.PlaybackStart` | upsert `playback_sessions` |
| `playback.progress` | `PlaybackProgress`, throttled to 30s | upsert session, extend `expires_at` |
| `playback.stop` | `PlaybackStopped` | delete session row |
| `item.played` | `IUserDataManager.UserDataSaved`, `SaveReason == PlaybackFinished` | insert `watch_events` |

**`item.played` is the only watched signal.** Do not derive "watched" from a stop event and
a percentage — Jellyfin already applies the user's configured threshold (default ~90%) and
fires `PlaybackFinished`, and it fires again on rewatch.

### 6.3 Library inventory

Two mechanisms, both required. Deltas keep the library fresh within minutes; snapshots are
the authority that repairs whatever the deltas missed.

#### 6.3.1 Incremental deltas

```
POST /api/v1/library/delta
Authorization: Bearer <server_secret>

{ "jellyfin_user_id": "f1c2...",
  "added":   [ <LibraryItem>, ... ],
  "removed": [ { "jellyfin_item_id": "8d9..." }, ... ],
  "updated": [ <LibraryItem>, ... ] }

→ 202 { "added": 3, "removed": 1, "updated": 0, "unmatched": 0,
        "quarantined": false }
```

Removals are keyed on `jellyfin_item_id` alone — the item is already gone from the sending
server, so no metadata is available to re-resolve it. That is what
`library_entries_identity` exists for. A removal for an unknown id is a silent no-op, not
an error.

`updated` covers a file being replaced in place: same Jellyfin item, new media profile
(the 1080p rip swapped for a 2160p one, or a German audio track added). It carries the full
`LibraryItem` and overwrites the profile columns.

Deltas are subject to the mass-removal safety valve (§7.6); `quarantined: true` means the
batch was held rather than applied, and the plugin should treat that as success and stop
retrying.

#### 6.3.2 Full snapshot

```
POST /api/v1/library/sync/start
{ "jellyfin_user_id": "f1c2...", "estimated_count": 4210 }
→ 200 { "sync_id": "uuid" }

POST /api/v1/library/sync/chunk
{ "sync_id": "uuid", "items": [ <LibraryItem>, ... ] }
→ 202 { "accepted": 500, "unmatched": 12 }

POST /api/v1/library/sync/finish
{ "sync_id": "uuid" }
→ 200 { "added": 41, "removed": 7, "unmatched": 12, "quarantined": false }
```

On `finish`, delete `library_entries` for that `(user_id, server_id)` whose
`last_confirmed_at` predates the sync start. Never delete on a sync that did not reach
`finish` — a crashed sync must not wipe a member's library. The same safety valve applies.

#### 6.3.3 `LibraryItem`

```jsonc
{
  "jellyfin_item_id": "8d9...",
  "item_type": "Movie | Episode",
  "name": "Rogue One",
  "production_year": 2016,
  "series_name": "Andor",
  "season": 1,
  "episode": 3,
  "provider_ids": { "Tmdb": "330459", "Imdb": "tt3748528" },
  "series_provider_ids": { "Tmdb": "83867" },
  "media": {                                  // optional; see §7.7
    "container": "mkv",
    "size_bytes": 24800000000,
    "runtime_sec": 8160,
    "video": { "codec": "hevc", "width": 3840, "height": 2160, "range": "HDR10",
               "bitrate": 22000000 },
    "audio": [ { "lang": "en", "codec": "truehd", "channels": 8, "default": true },
               { "lang": "de", "codec": "eac3",   "channels": 6, "default": false } ],
    "subtitles": [ { "lang": "de", "codec": "subrip", "forced": false, "external": true },
                   { "lang": "en", "codec": "pgssub", "forced": true,  "external": false } ]
  }
}
```

`media` is omitted when the plugin has profile reporting disabled. Never include file paths
or filenames — they leak directory structure and often the release group's naming of things
the member would rather not publish.

### 6.4 Command channel (long poll)

This is how the tracker reaches a member's LAN without inbound connectivity.

```
GET /api/v1/commands?wait=30
Authorization: Bearer <server_secret>

200 { "commands": [ { "id": "uuid", "kind": "seerr.request", "payload": {...} } ] }
   (returns [] after `wait` seconds if nothing is queued)

POST /api/v1/commands/{id}/result
{ "ok": true, "result": { "remote_request_id": "1487" } }
   or { "ok": false, "error": "connection refused" }
```

Server-side: hold the request open up to 30s using a Postgres `LISTEN/NOTIFY` subscription
on a `plugin_commands` channel, falling back to a 1s poll loop. Claimed commands time out
back to `queued` after 60s with `attempts += 1`; after 3 attempts they go to `failed`.

### 6.5 Bot API

Consumed by the existing Discord bot. Static bearer token (`BOT_API_TOKEN`).

```
GET /api/v1/bot/now-playing
→ { "sessions": [ { "discord_id": "...", "display_name": "...", "title": "Andor",
      "subtitle": "S01E03 · Reckoning", "position_sec": 812, "runtime_sec": 2610,
      "is_paused": false, "server_name": "LarsFlix", "poster_url": "..." } ] }

GET /api/v1/bot/users/{discord_id}/recent?limit=10
GET /api/v1/bot/screenings/upcoming
```

`now-playing` excludes users whose `nowplaying_visibility = 'private'`.

---

## 7. Jellyfin plugin

`plugin/Jellyfin.Plugin.Tracker`, .NET 8, targeting Jellyfin 10.10.

### 7.1 Skeleton

- `Plugin.cs : BasePlugin<PluginConfiguration>, IHasWebPages` — GUID, name, config page.
- `PluginConfiguration` — `TrackerBaseUrl`, `ServerId`, `ServerSecret`, `ExcludedLibraryIds
  (string[])`, `Enabled`, `SeerrRelayEnabled`.
- `Configuration/configPage.html` — the admin UI (§7.5).
- `ServiceRegistrator : IPluginServiceRegistrator` — register the hosted services below.

### 7.2 Event capture

Subscribe in a hosted service:

```csharp
_sessionManager.PlaybackStart    += OnPlaybackStart;
_sessionManager.PlaybackProgress += OnPlaybackProgress;   // throttle to 1 per 30s per session
_sessionManager.PlaybackStopped  += OnPlaybackStopped;
_userDataManager.UserDataSaved   += OnUserDataSaved;      // filter SaveReason == PlaybackFinished
```

For each event: resolve the `BaseItem`, skip it if its top-level library is in
`ExcludedLibraryIds`, extract `ProviderIds`, and for an `Episode` also walk to
`item.Series` for the series-level provider IDs (episode-level TMDB ids are frequently
missing in real libraries; the series id plus season/episode numbers is the reliable path).

### 7.3 Outbound queue

Member servers lose connectivity; events must not be lost.

- Persist queued events to SQLite in the plugin data directory
  (`Path.Combine(_appPaths.PluginConfigurationsPath, "tracker-queue.db")`).
- Flush every 15s, or immediately when the queue exceeds 50 items.
- Exponential backoff on failure: 15s → 30s → 1m → 5m → 15m, capped.
- Drop events older than 30 days.
- Never block a Jellyfin event handler on network I/O. Enqueue and return.

### 7.4 Library sync

Two mechanisms with different jobs. Deltas exist for latency; the snapshot exists because
deltas are lossy and nobody notices when they go wrong.

**Deltas.** Subscribe to `ILibraryManager.ItemAdded`, `ItemUpdated`, and `ItemRemoved`.
Accumulate into an in-memory buffer, flush 60 seconds after the last event in the buffer
(capped at 5 minutes so a long Arr import still reports in slices rather than one giant
batch at the end). Route the flush through the same persistent queue as watch events
(§7.3) so a delta survives the tracker being unreachable.

`ItemRemoved` gives you an `ItemChangeEventArgs` whose `Item.Id` is all you need — send the
id, nothing else. Do not try to resolve provider IDs at removal time; the item is being
torn down and the metadata may already be gone.

Filter every event against `ExcludedLibraryIds` before buffering, using
`_libraryManager.GetCollectionFolders(item)` to find the item's top-level library. For
`ItemRemoved` the ancestor chain may already be unresolvable — if the library can't be
determined, send the removal anyway. A removal leaks nothing: the tracker either knows that
id or ignores it.

**Snapshot.** An `IScheduledTask` ("Tracker: full library sync"), daily at 04:00, plus a
manual run button. Enumerate with `ILibraryManager.GetItemList` using
`IncludeItemTypes = [Movie, Episode]` and `Recursive = true`, exclude the excluded
libraries, chunk at 500 items. Run it per local Jellyfin user — the plugin does not know
which accounts are linked, so it sends all of them and the tracker discards the unlinked
ones at ingest.

The snapshot is what repairs a missed `ItemRemoved` (plugin was down, Jellyfin restarted
mid-scan, an event handler threw). Do not be tempted to drop it once deltas work; the
failure mode it covers is silent.

### 7.5 Admin config page

- Tracker URL + "Register" button, taking a registration code (§6.1).
- Connection status: last successful push, queue depth, plugin version vs. latest.
- Checkbox list of libraries, for exclusion. Excluded libraries are never transmitted — not
  their titles, not their existence.
- Account linking table: local Jellyfin users with their link state, and an "invite" action
  producing a link the owner sends to that member (§8).
- Seerr relay toggle (§13.3).

### 7.6 Library integrity: the mass-removal safety valve

**This is the single highest-risk piece of the delete path, and it needs to exist before
deltas ship.**

Jellyfin fires `ItemRemoved` when a scan finds files missing — and "missing" includes "the
storage backend is temporarily unavailable." A member whose library sits on a network
mount, an external drive, or an rclone mount over a cloud provider will, sooner or later,
have that mount drop while Jellyfin runs a scan. Jellyfin then correctly concludes that
several thousand files are gone and emits removals for all of them. Without a guard, the
tracker faithfully deletes that member's entire library, their availability goes red across
every screening, and the repair only happens on the next successful snapshot — assuming the
mount is back by then.

The guard, applied identically to deltas and to snapshot reconciliation:

- Compute the proposed removal count against the member's current entry count for that
  server.
- If it would remove **more than 10% of entries, or more than 200 entries**, whichever is
  lower, do not apply it. Write the pending removal set to a `library_sync_quarantine`
  table, return `quarantined: true`, and leave the existing entries untouched.
- Notify the server owner on the website (`/settings/servers`) with the count and a sample,
  and a single **Apply** button. Also notify via Discord DM if a bot user is available.
- Auto-release without confirmation only if the same removal set arrives in **three
  consecutive** full snapshots at least 6 hours apart. A genuinely deleted library reports
  consistently; a flapping mount does not.
- Never quarantine *additions*. A false-positive addition is harmless.

```sql
CREATE TABLE library_sync_quarantine (
  id            uuid PRIMARY KEY,
  server_id     uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  entry_ids     uuid[] NOT NULL,
  entry_count   integer NOT NULL,
  library_count integer NOT NULL,      -- total at time of proposal
  fingerprint   text NOT NULL,         -- hash of the sorted entry_ids
  occurrences   smallint NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolution    text CHECK (resolution IN ('applied','dismissed','auto_applied'))
);
```

`fingerprint` is what lets you count consecutive occurrences of the *same* removal set
rather than three unrelated flaps in a row.

### 7.7 Media profile extraction

Yes — and it needs no probing, because Jellyfin already ran ffprobe at scan time and stores
the result. Read it, don't recompute it.

```csharp
var streams = _mediaSourceManager.GetMediaStreams(new MediaStreamQuery { ItemId = item.Id });
```

Each `MediaStream` carries `Type` (`Audio` / `Video` / `Subtitle`), `Language`, `Codec`,
`Channels`, `IsDefault`, `IsForced`, `IsExternal`, and for video `Width`, `Height`,
`VideoRangeType`, `BitRate`. Container and size come from the item itself (`item.Container`,
`item.Size`) or `item.GetMediaSources(false)` for multi-version items — for those, report
the **best** version by height, since that is what determines whether the group can watch it
together.

**Language normalisation is the real work here.** Jellyfin stores whatever the file's
metadata claimed, which in a real library means all of the following appear for German:
`ger`, `deu`, `de`, `de-DE`, `German`, `""`, and `und`. Normalise to ISO 639-1 in the
plugin, not on the tracker, using a static map covering ISO 639-2/B (`ger`, `fre`, `dut`,
`chi`, `cze`, `gre`, `ice`, `mac`, `mao`, `may`, `per`, `rum`, `slo`, `wel`, `arm`, `baq`,
`bur`, `geo`, `tib`) alongside 639-2/T. Map anything unrecognised, empty, or `und` to the
literal string `und` and keep it — "has an audio track of unknown language" is different
information from "has no audio track", and for a lot of single-language rips `und` is the
member's own language.

**Cost control.** A 20,000-episode library would otherwise re-read streams for every item
on every nightly snapshot. Cache the profile in the plugin's SQLite database keyed by
`(item_id, item.DateModified)`; on snapshot, re-read only items whose `DateModified`
changed. Delta events always re-read, since that is exactly when the file changed.

**Opt-out.** A `ReportMediaProfile` config toggle, default on. When off, `media` is omitted
and the tracker leaves the profile columns null — availability still works, language-aware
readiness does not.

### 7.8 Distribution

Publish a plugin repository manifest so members add the repo URL once and get updates
automatically. Serve `https://tracker.lehdev.de/plugin/manifest.json` from the Next.js app,
built by CI on release. Include the plugin version in every ingest request; the website's
server list shows an "outdated" badge below the current minimum. Assume nobody updates
manually.

---

## 8. Account linking

Two-sided consent, because the server owner is trusted for their server but should not be
able to silently attribute watches to a member who never opted in.

1. Owner opens the plugin config page (or the tracker's server page) and sees the Jellyfin
   accounts on their server, reported by the plugin.
2. Owner picks a Jellyfin account and generates an invite. The tracker creates a
   `server_accounts` row with `link_state = 'pending'` and returns a URL with a signed,
   time-limited token.
3. Owner sends that URL to the member over Discord.
4. Member opens it while signed in to the tracker, sees "*LarsFlix* claims you are the
   Jellyfin user `anna` — accept?", and confirms. `link_state = 'linked'`,
   `user_id` set.
5. Events for `link_state != 'linked'` are dropped at ingest, but the account row is kept
   updated so it stays visible in the owner's UI.

A member may be linked to several servers (their own plus LarsFlix). One Jellyfin account
maps to exactly one tracker user. Unlinking sets `link_state = 'rejected'` and stops future
ingest, but does **not** delete historical `watch_events` — offer a separate explicit
"delete my data from this server" action.

---

## 9. Media matching

Every incoming item must resolve to a `media_items` (and for episodes, `episodes`) row.

Resolution order:

1. `provider_ids.Tmdb` → direct lookup, then TMDB fetch on miss.
2. `provider_ids.Imdb` or `Tvdb` → TMDB `/find/{external_id}`.
3. For episodes: resolve the **series** by the above, then match `season`/`episode` numbers
   against `episodes`. Fetch the season from TMDB if the episode row is missing.
4. Fallback: TMDB `/search/{movie,tv}` on `name` + `production_year`. Accept only an exact
   normalised title match with a year within ±1. Normalisation: lowercase, strip
   punctuation and articles, fold diacritics.
5. Otherwise: write `unmatched_items` and return `unmatched` for that entry. Do not guess.

Expect the unmatched queue to be non-trivial for anime, older European films, and
hand-organised libraries. Build a small admin page listing unmatched items grouped by
normalised title, with a TMDB search box to resolve them. Resolving one should backfill any
`library_entries` and `watch_events` that were pending on it.

TMDB responses are cached in `media_items` / `episodes`; refresh metadata lazily when
`metadata_refreshed_at` is older than 30 days (7 days for shows still airing, so
`episode_count` stays correct for progress calculations).

---

## 10. Watch status

Derived, never hand-set. For a show and a user:

- `planned` — no watch events, but present in library.
- `watching` — at least one episode watched, fewer than all aired episodes.
- `completed` — all aired episodes have at least one watch event.
- `stalled` — `watching`, but no event in 60 days. (Presentational only; do not offer a
  "dropped" state the user must curate — nobody curates it.)

Expose it as a SQL view over `watch_events` + `episodes.episode_count`. Next-up episode =
lowest `(season, number)` with no watch event, ignoring season 0 (specials).

---

## 11. Discord announcements

### 11.1 Debouncing

A member watching six episodes in a row must produce one message, not six.

- On inserting a `watch_events` row for an **episode**: upsert an open
  `announcement_batches` row for `(user_id, show_id)` with
  `window_ends_at = now() + 10 minutes`, extending the window on each new episode, capped at
  60 minutes from batch creation so a long binge still posts eventually.
- **Movies** post immediately, no batch.
- A pg-boss job runs every 30s, picks batches where `window_ends_at < now()` and
  `sent_at IS NULL`, collects the member's episode events for that show since batch
  creation, posts one message, sets `sent_at`, and marks the events `announced`.

### 11.2 Message shape

Discord embed, posted via `DISCORD_ANNOUNCE_WEBHOOK_URL`:

- Single movie: "**Lars** watched **Rogue One** (2016)" + poster thumbnail, runtime, and
  "Rewatch" tag if `is_rewatch`.
- Episode batch: "**Lars** watched **Andor** — S01E01–E06" with episode titles in the
  description (truncate past 8 and append "+ n more").
- Mixed seasons in one batch: list ranges per season.

### 11.3 Suppression

Never announce when any of these hold:

- `users.announce_watches = false`
- the event came from an import (`source LIKE 'import_%'`)
- `announce_suppressed = true` (set retroactively by the member from their history page)
- the event was backfilled during initial library sync

The import case matters: **the announcement path must be bypassed entirely during import**,
not merely filtered per-event. The first member to import several years of Trakt history
would otherwise post thousands of messages.

---

## 12. Screenings

- Any member creates one: pick a movie or episode via TMDB search, set a start time, add
  notes. Participants join with an RSVP.
- The readiness grid computes, per participant, whether the item exists in
  `library_entries` for any of their linked servers, and shows which server. Computed at
  render time.

### 12.1 Language-aware readiness

With media profiles available (§7.7), readiness stops being a boolean. Two people each
"having" a film is useless if one copy is German-only and the other English-only and they
intend to watch it together.

Add to `screenings`:

```sql
ALTER TABLE screenings
  ADD COLUMN audio_lang    text,     -- ISO 639-1, null = don't care
  ADD COLUMN subtitle_lang text;
```

Readiness becomes four states per participant:

| State | Meaning |
|---|---|
| `ready` | has it, and the copy satisfies the screening's language requirement |
| `language_mismatch` | has it, but no matching audio track (subtitles may still cover it) |
| `missing` | not in any linked library |
| `unknown` | has it, but the copy has no profile data — treat as ready, badge it |

`und` audio counts as a match for any requested language, with a badge. Guessing wrong here
is much cheaper than showing a red dot for a member whose perfectly good single-audio rip
was tagged badly at encode time.

**Suggested language.** When a screening is created, compute the intersection of
`audio_langs` across the participants who already have the item, and default
`screenings.audio_lang` to the most common member language in that intersection. Show the
alternatives: "6 of 7 can watch in English; 4 of 7 in German." This is the question the
readiness grid is actually being used to answer, and it's only answerable because the
profile data is there.

Also surface, informationally and without gating readiness on it: highest available
resolution per participant, and whether anyone's copy is HDR while others' are SDR. Useful
for deciding whose server to watch on; not a reason to mark anyone unready.
- A participant without the item gets a **Request** button (§13), and a "watch on
  <server>" hint for any *other* participant's server they're also linked to — in practice
  the common resolution is watching on LarsFlix rather than everyone acquiring a copy.
- Post the screening to Discord on creation and 30 minutes before start, editing the
  original message rather than posting again on RSVP changes.
- Readiness is only meaningful for participants with at least one linked server; show
  "no server linked" rather than a red dot.

---

## 13. Seerr integration

Each member configures their **own** Seerr instance. It defaults to the shared instance
(`DEFAULT_SEERR_BASE_URL`) and can be repointed at anything, including a machine on their
own LAN.

### 13.1 Why routing is not one code path

A member setting `http://192.168.1.50:5055` is describing a host the tracker's VPS cannot
reach — and must not try to reach, because that address resolves to something entirely
different from the VPS's perspective. Browser-side calls are not a workaround either:
Jellyseerr does not emit CORS headers for third-party origins, so a `fetch` from the
tracker's web page to the member's instance is blocked.

So the routing mode is determined by the URL, at save time:

| Resolved host | `routing` | Path |
|---|---|---|
| public IP | `direct` | tracker's worker calls it server-side |
| private / loopback / link-local / `.local` | `relay` | queued as a `plugin_commands` row, executed by the member's plugin on their LAN |

`relay` requires the member to have at least one linked server with the relay toggle
enabled; if they have several, they pick which one relays.

### 13.2 Direct mode and SSRF

A user-supplied URL fetched by the server is textbook SSRF. Because private addresses go
down the relay path anyway, `direct` mode can simply **hard-block** everything non-public,
which doubles as the routing decision:

- Resolve the hostname, and reject if any resolved address is in `10/8`, `172.16/12`,
  `192.168/16`, `127/8`, `169.254/16` (including `169.254.169.254`), `::1`, `fc00::/7`,
  `fe80::/10`, or is not a global unicast address.
- **Re-resolve at request time and pin the connection to the validated IP** — validating at
  save time only is a DNS-rebinding hole.
- Disallow redirects. Require `https` unless the host is explicitly allowlisted.
- 5s connect timeout, 15s total, 1 MB response cap.

Put this in one `packages/contracts/safe-fetch.ts` helper and use it for nothing else.

### 13.3 Relay mode

1. Member clicks Request. Tracker writes `media_requests` (`status = 'submitting'`) and a
   `plugin_commands` row with `kind = 'seerr.request'`, payload
   `{ request_id, base_url, api_key, media_type, tmdb_id, seasons? }`.
2. The member's plugin picks it up on its next long poll, calls their local Jellyseerr, and
   POSTs the result back.
3. Tracker updates `media_requests` with `remote_request_id` and `status = 'pending'`.
4. A periodic job issues `seerr.status` commands for open requests (or direct calls in
   `direct` mode) every 10 minutes, up to 7 days.

The API key is decrypted only when building the command payload, and travels to the plugin
over TLS. It is the member's own key going to the member's own machine — but never log it,
and never return it to the browser after saving (write-only field, show a masked
placeholder).

### 13.4 Calls made

Jellyseerr and Overseerr share the v1 API surface:

```
GET  /api/v1/status                        → connectivity + version check, sets `flavour`
POST /api/v1/request                       → { mediaType: "movie"|"tv", mediaId: <tmdbId>,
                                               seasons?: [1,2] }
GET  /api/v1/request/{id}                  → status
```

Auth header: `X-Api-Key: <key>`. Requests are submitted as the API key's owner, which for a
personal instance is that member — so no user-mapping problem in relay mode. On the shared
default instance, everything arrives as the service account; note in the UI that requests
to the default instance are attributed to the instance owner.

### 13.5 Settings UI

Under `/settings/seerr`: base URL, API key (write-only), a **Test connection** button that
runs `/api/v1/status` through whichever route applies and reports the resolved routing mode
back to the member, plus the relay server picker when relevant. Never save an unverified
config silently — show the error.

---

## 14. Trakt / SIMKL import

One-time, per member, user-initiated. No background sync, no scheduled re-run.

**Trakt** is the better source: `GET /users/me/history` is paginated and returns one row per
*play* with a real `watched_at`, including separate rewatch instances. Use
`?limit=100&page=n`, respect `X-Pagination-Page-Count`, and honour the rate-limit headers.
Map via the `ids` object (`trakt`, `tmdb`, `imdb`, `tvdb`) — TMDB first.

**SIMKL**: `GET /sync/all-items/{type}?extended=full` returns state rather than history —
generally one `last_watched_at` per item, with a per-episode watched list for shows but no
per-play timestamps. Import those as single events with
`watched_at_is_approximate = true`. Do not backdate to a fabricated date; if there is no
usable timestamp at all, use the import timestamp and flag it.

Both run as pg-boss jobs writing to `import_jobs.stats`
(`{ fetched, matched, inserted, unmatched, skipped_duplicate }`), with a progress page.
Set `source = 'import_trakt' | 'import_simkl'` and, per §11.3, do not touch the
announcement path.

Deduplicate against existing rows on `(user_id, media_item_id, episode_id, watched_at)`
within a 6-hour window, so re-running an import or importing both providers doesn't double
up a member's history.

---

## 15. Privacy

Two enforcement points, protecting different things.

**On the member's own server (plugin):** library exclusion. Excluded libraries are never
transmitted at all — not their contents, not their names, not the fact that they exist.
This is where private material belongs, because it never leaves the machine.

**On the tracker:** `announce_watches`, `history_visibility`, `nowplaying_visibility`, plus
a per-event "don't announce / hide this" toggle on the history page. Private history is
still visible to the member themselves and still counted in their own stats.

Additional rules:

- Sign-in is restricted to members of `DISCORD_GUILD_ID`. Verify guild membership at login,
  not just Discord identity.
- No page is public. There is no anonymous view of anything.
- A "delete my account" action removes `watch_events`, `library_entries`,
  `playback_sessions`, `seerr_configs`, and `server_accounts` links for that member, and
  anonymises `screenings.created_by`.
- Never log Seerr API keys, server secrets, or Jellyfin item paths.

---

## 16. Website routes

```
/                          dashboard — now playing, recent activity, upcoming screenings
/u/[discord_id]            member profile — stats, currently watching, recent
/u/[discord_id]/history    paginated watch history, filters, per-event visibility toggle
/u/[discord_id]/library    library across their linked servers, filter by server
/media/[kind]/[tmdbId]     title page — who has it, who watched it, create screening
/screenings                list
/screenings/[id]           detail — readiness grid, RSVP, request buttons
/settings/servers          linked servers, registration codes, plugin status, unlink
/settings/seerr            §13.5
/settings/privacy          §15
/settings/import           Trakt/SIMKL OAuth + progress
/admin/unmatched           unmatched item resolution (owner only)
```

Now-playing updates via SSE from `/api/stream/now-playing`; everything else is server
components with normal navigation. Do not add a client-side data-fetching library for this.

---

## 17. Deployment

Docker Compose alongside the existing stack on the Netcup VPS. Services: `web`, `worker`,
`postgres`. Exposed through Cloudflare Tunnel — unlike `filme.lehdev.de`, this app serves no
media, so the tunnel is appropriate here.

- `web` and `worker` build from the same image, different entrypoints.
- Migrations run as a one-shot init container (`drizzle-kit migrate`), never on app boot.
- Health: `/api/health` checking DB connectivity and pg-boss.
- Back up `watch_events`, `users`, `servers`, `server_accounts`, and `screenings` nightly.
  Everything else is reconstructible; those are not.

---

## 18. Milestones

Each milestone must be independently deployable and leave the system in a working state.

**M1 — Foundation.** Monorepo, Drizzle schema through §5.4, Auth.js Discord login with
guild-membership check, TMDB client with caching, server registration + registration codes,
account-linking flow (§8). *Acceptance:* a member can sign in, register a server via the
API, and link a Jellyfin account end to end.

**M2 — Plugin and ingest.** Plugin skeleton, event capture, persistent outbound queue,
config page, ingest endpoint, media matching with unmatched quarantine, library deltas and
full snapshots, the mass-removal safety valve (§7.6), media profile extraction with language
normalisation, now-playing sessions with TTL expiry. *Acceptance:* watching an episode on a
real remote Jellyfin server produces a `watch_events` row within 30s and a live
`playback_sessions` row; killing the tracker for 10 minutes mid-watch loses nothing; adding
and then deleting a file is reflected within ~2 minutes; and **unmounting the media
directory and forcing a Jellyfin scan quarantines the removals instead of applying them**.
That last one is a required test, not an optional one — write it before writing the delete
path.

**M3 — Discord output.** Announcement batching and webhook posting, bot API (§6.4).
*Acceptance:* six episodes back to back produce exactly one message; `/watching` returns
live sessions and respects `nowplaying_visibility`.

**M4 — Website.** Dashboard, profile, history, library, media pages, watch-status view,
unmatched admin page. *Acceptance:* a member can see their full history and library and
correctly identify which server has what.

**M5 — Import.** Trakt and SIMKL OAuth, import jobs, dedup, approximate-timestamp handling,
announcement bypass. *Acceptance:* importing a large Trakt history posts zero Discord
messages and produces no duplicate events on a second run.

**M6 — Screenings.** Creation, RSVP, readiness grid, language-aware readiness and suggested
language, Discord posting. *Acceptance:* readiness reflects a library change made minutes
earlier, and a participant holding a German-only copy of an English-language screening shows
`language_mismatch` rather than `ready`.

**M7 — Seerr.** Settings UI, routing detection, SSRF-guarded direct mode, relay via the
command channel, status polling. *Acceptance:* a request routed to a `192.168.x.x` instance
succeeds through the plugin relay, and the same URL is refused by the direct path.

---

## 19. Open questions

Raise these before they block you; do not guess.

1. **Existing Discord bot language and repo.** §6.4 assumes the bot calls the tracker.
   Confirm the bot's stack before writing any client code for it.
2. **Multi-user Jellyfin servers other than LarsFlix.** If members' personal servers also
   host family accounts, the linking UI needs to make "don't link this one" the obvious
   default. Confirm whether that case exists.
3. **Manual watch entry.** The schema supports `source = 'manual'` for things watched at the
   cinema or on Netflix. Is a UI for it in scope, or is Jellyfin the only source post-import?
4. **Screening reminders.** Discord ping on start, or passive message only?
5. **Retention for `playback_sessions` history.** Currently ephemeral only. If "hours
   watched per week" stats are wanted later, sessions need archiving rather than deletion —
   decide before M2 rather than after.