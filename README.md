# Media Tracker

A self-hosted, Trakt-like movie and series tracker for a Discord community whose
members each run their own Jellyfin instance.

The binding design document is `docs/SPEC.md`. Read sections 1–3 of it before
changing anything: the three constraints there (member servers are unreachable
from the tracker, one server can host many members, the server owner is the
trust boundary) explain most of the decisions in this code.

## Status

| Milestone | State | Notes |
|---|---|---|
| M1 Foundation | **done** | monorepo, schema §5.1–5.4, Discord auth + guild check, TMDB client, server registration, account linking |
| M2 Plugin and ingest | **in progress** | mass-removal safety valve (§7.6) and session expiry/archiving done; next: ingest, media matching, delta/snapshot endpoints, then the .NET plugin |
| M3 Discord output | not started | |
| M4 Website | not started | M1 ships placeholder pages only |
| M5 Import | not started | |
| M6 Screenings | not started | |
| M7 Seerr | not started | |

## Layout

```
apps/web        Next.js 15 App Router — website and all HTTP APIs
apps/worker     pg-boss consumers (empty until M2)
packages/db     Drizzle schema, migrations, seed
packages/contracts  Zod schemas — the source of truth for every wire format
packages/tmdb   TMDB client, media resolution (§9) and caching
plugin/         Jellyfin.Plugin.Tracker (.NET 8) — M2
docker/         Dockerfile and compose stack
```

## Running it locally

Requires Node 22+, pnpm, and Docker.

```bash
pnpm install
```

Start a Postgres for development:

```bash
docker run -d --name media-tracker-db -e POSTGRES_USER=tracker -e POSTGRES_PASSWORD=tracker -e POSTGRES_DB=media_tracker -p 5433:5432 postgres:16-alpine
```

Copy the environment template and fill it in:

```bash
cp .env.example .env
```

`AUTH_SECRET` and `SECRETS_ENC_KEY` both want 32 random bytes:

```bash
openssl rand -base64 32
```

`apps/web/.env` and `apps/worker/.env` are symlinks to the root `.env`, so the
one file serves everything.

Apply migrations, then run the two processes:

```bash
pnpm db:migrate
```

```bash
pnpm dev:web
```

```bash
pnpm dev:worker
```

Signing in needs a real Discord application whose redirect URI is
`$PUBLIC_BASE_URL/api/auth/callback/discord`, with `AUTH_DISCORD_ID`,
`AUTH_DISCORD_SECRET` and `DISCORD_GUILD_ID` set. To work without that, seed a
member directly:

```bash
pnpm db:seed
```

## Verifying M1

`apps/web/scripts/e2e-m1.ts` drives the M1 acceptance criteria against a running
instance: registration over HTTP, single-use codes, bearer auth, account
reporting, invite issuing, two-sided consent, and revocation. Build and start
the app, then:

```bash
pnpm --filter @media-tracker/web exec tsx --env-file=.env scripts/e2e-m1.ts
```

`--env-file` is needed because `tsx` does not read `.env` the way `next` does.
It points at `http://127.0.0.1:3100` by default; override with `E2E_BASE_URL`.

The unit and integration suites run separately:

```bash
pnpm test
```

Integration tests need the development Postgres from above to be running and
migrated; they create and drop their own schema per file, so they never touch
your development data. Without `DATABASE_URL` they skip rather than fail.

## Database changes

The schema lives in `packages/db/src/schema`. After editing it:

```bash
pnpm db:generate
```

Review the generated SQL in `packages/db/drizzle/` before applying it. Migrations
run as a one-shot init container in production and are never applied on app boot.

## Deployment

`docker/compose.yaml` builds one image and runs it three ways — `migrate`, `web`,
`worker` — alongside a Postgres. `web` binds to loopback only; put Cloudflare
Tunnel in front of it.

Back up `watch_events`, `users`, `servers`, `server_accounts` and `screenings`.
Jellyfin keeps no watch history of its own, so `watch_events` cannot be
reconstructed from a member's server if it is lost.
