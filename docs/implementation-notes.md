# Implementation notes — M1, M2 (in progress)

Everything here is a decision made while building M1 that the spec did not
already settle, or a place where the code departs from it. Section numbers refer
to `SPEC.md`.

## Additions to the spec

### `registration_codes` table

§6.1 describes one-time registration codes but §5 has no table for them. Added:

```
registration_codes(id, code_hash, owner_user_id, expires_at, used_at, server_id, created_at)
```

The code is stored as a SHA-256 hash and looked up by hash, so a database read
does not hand out live codes. A code is 8 characters from a 32-symbol alphabet —
40 bits — so `POST /api/v1/servers/register` is rate limited to 10/minute per
address as well. Claiming is a conditional `UPDATE ... WHERE used_at IS NULL`
inside the registration transaction, which makes it single-use even if two
plugins race the same code.

### `POST /api/v1/accounts/report` and `POST /api/v1/accounts/invite`

§6 defines no endpoint for the plugin to report its local Jellyfin users, but
§7.5 requires the plugin's config page to render "local Jellyfin users with their
link state", and §6.2 requires an account row to exist so unlinked users appear
in the owner's linking UI. Both are in `packages/contracts/src/accounts.ts`.

`report` is a report, never an assertion of identity (C2). Its `ON CONFLICT`
clause touches only `jellyfin_username`, so a server cannot advance, reset, or
reassign a link by re-reporting — only the member accepting an invite moves
`link_state`. There is a test for exactly this in the M1 acceptance script.

### Server bearer token shape

§6.1 says "opaque-64-char". The token is `<server-id>.<32 random bytes>`, both
base64url. The id prefix is not a secret; it exists so a request resolves to one
row before the argon2 verify, instead of verifying against every server's hash.
Successful verifications are cached for five minutes against a SHA-256 of the
presented token, because argon2id costs tens of milliseconds and the plugin hits
ingest continuously. The cached entry is still re-checked against `revoked_at`
on every request, so revocation takes effect immediately.

## Deviations

### Show metadata refreshes every 7 days, not 30

§9 asks for a 30-day refresh dropping to 7 for shows still airing. §5.2 has
nowhere to record airing status, so every show refreshes on the 7-day cadence and
movies keep 30 days. That is the conservative direction — `episode_count` stays
correct for progress calculations — at the cost of one TMDB call per show per
week. Adding a `status` column to `media_items` would recover the original
behaviour.

### `media_items.episode_count` is TMDB's `number_of_episodes`

§10 wants watch status against *aired* episodes. `number_of_episodes` includes
episodes announced but not yet aired, so it will read slightly high for a show
mid-season. `episodes.air_date` is populated whenever a season is fetched, so the
M4 watch-status view should count `episodes` with `air_date <= now()` and treat
`episode_count` as a fallback for shows whose seasons have never been pulled.

### Guild membership is verified at sign-in only

§15 says to verify guild membership at login, which is what happens. Because
sessions are JWTs, a member removed from the guild keeps access until their
session expires; `session.maxAge` is set to 7 days to bound that. Closing the
window entirely needs either the Discord OAuth token retained for periodic
re-checks, or a bot token to query membership server-side. Neither is in the §4
configuration, so it is left open deliberately — see the open question below.

### `SKIP_ENV_VALIDATION`

`next build` imports server modules to collect page data, so a Docker build layer
would otherwise need the full production secret set just to compile. The flag
bypasses validation for that, and only that; at runtime the parse is strict and a
misconfigured deploy fails at boot, per §4.

## Things M2 must not skip

- ~~Write the mass-removal quarantine test before the delete path~~ (§7.6, §18
  M2 acceptance) — **done**, before any delete path existed. `library_sync_quarantine`
  landed in migration `0001`. See the M2 section below.
- `library_entries_identity` (`server_id`, `jellyfin_item_id`) already exists so
  incremental removals can find their row without re-resolving metadata.
- `watch_events.is_rewatch` is computed at insert, not stored by the plugin.
- `playback_sessions` cleanup is a periodic worker job driven by `expires_at`,
  not by stop events.

## Open questions still outstanding

The spec's §19 list, with M1's answers where M1 produced one:

1. **Discord bot language and repo** — still unanswered; blocks M3's §6.4 client.
2. **Multi-user personal servers** — the linking UI already makes "don't link
   this one" the default: reported accounts sit at `unlinked` and nothing is
   attributed until a member accepts an invite. No further work needed unless the
   owner wants bulk invites.
3. **Manual watch entry** — schema supports `source = 'manual'`; no UI built.
4. **Screening reminders** — untouched, M6.
5. ~~**`playback_sessions` retention**~~ — **answered**: archive a summary row
   on expiry. See the M2 section below.

Additionally, from M1:

6. **Session-length vs. guild-removal window** — see the deviation above. Worth
   deciding whether 7 days is acceptable or whether a bot token should be added
   to §4.

---

# M2

## The mass-removal safety valve (§7.6)

Written test-first, as §18 requires. `apps/web/src/server/library-quarantine.ts`
with `library-quarantine.test.ts` beside it; the suite was checked against three
mutations (threshold cap raised, valve disabled, deltas allowed to advance the
streak) and catches all three.

Decisions the spec left open:

### Only snapshots advance the auto-release streak

§7.6 says "three consecutive full snapshots at least 6 hours apart", so deltas
are counted as sightings but never advance `occurrences`. `last_seen_at` tracks
the last *counted* sighting rather than every proposal: deltas arrive every
minute or two, and updating the timestamp on each one would keep resetting the
six-hour clock so the streak could never accumulate.

### A snapshot proposing a different set dismisses the old one

The snapshot is the authority. If it stops proposing a removal set, those items
are back, so the open row is resolved as `dismissed` rather than left to bank
its third sighting and auto-apply later. Without this a flapping mount could
alternate between two sets and eventually release one it no longer reports.

### Ids that are no longer in the library do not count toward the threshold

A re-sent delta, or a removal for an item already gone, would otherwise inflate
the batch over the threshold and quarantine a removal of two entries. Proposed
ids are resolved against `library_entries` first and the count is taken from
what actually matched.

### Threshold is exclusive, with a floor of 5

`max(5, min(floor(0.1 × entries), 200))`, and removing *exactly* that many is
allowed. §7.6 specifies only the two ceilings; the floor is an addition, agreed
before the delta path was written.

Why: the proportional half of the rule is aggressive on a small library — at 30
entries a pure 10% rule flags four removals, so a member tidying up gets a
quarantine notice. The risk is not the notice, it is that an owner who sees it
weekly learns to press Apply without reading, which is exactly the reflex the
guard depends on not existing. §0 puts §7.6 in the "follow, but flag what turns
out to be wrong" range rather than the binding sections, so this is a flagged
adjustment rather than a deviation from a binding rule. A wipe of a small
library is still caught: 30 of 30 is well over the floor.

## Session expiry and archiving (§5.3, §19 q5)

Open question 5 is answered: **archive a summary row, then delete**. The
retrofit was the deciding factor — once a session row is deleted the time it
represents is gone, so "hours watched per week" could only ever have covered
the period after the decision, and the decision could not be deferred past M2.

`playback_session_archive` (migration `0002`, not in §5) takes one row per
finished session: user, server, media, episode, device, `started_at`,
`ended_at`, final `position_sec`, `runtime_sec`. Deliberately *not* the
heartbeats — position updates land every 30 seconds per session and none of
that survives aggregation.

- `ended_at` is the last heartbeat (`updated_at`), not `expires_at`. The
  two-minute TTL is slack; counting it would inflate every session by two
  minutes.
- The archive row reuses the expired session's id, so a replayed drain
  conflicts with itself instead of double counting.
- The archive's `server_id` does **not** cascade, matching `watch_events`:
  disowning a server must not silently rewrite a member's history (§8).
- `apps/worker/src/jobs/session-expiry.ts`, on a one-minute pg-boss cron. With
  a two-minute TTL a session lingers in "now playing" for at most three minutes
  after a server goes quiet.

## Ingest (§6.2)

`apps/web/src/server/ingest.ts` behind `POST /api/v1/ingest`. The resolver from
M1 already covered §9, so this is the identity, idempotency and session layer.
Decisions the spec left open:

### `unlinked_account` is a **permanent** rejection

The retry contract says the plugin may only drop events the tracker accepted or
rejected as permanent, so this determines whether pre-link watches are banked
and flushed the moment a member accepts an invite. They are not. §8 is
two-sided consent, and replaying watches from before the member agreed would
make that consent retroactive. Losing them is the intended behaviour, not a
limitation.

### `unmatched` is **not** permanent

The opposite call, for the opposite reason. §9 says resolving an unmatched item
should backfill the events pending on it — but `watch_events.media_item_id` is
NOT NULL, so the tracker has nowhere to hold one. The plugin's own queue is the
only place the event still exists, so it keeps it and retries; an admin
resolving the item on `/admin/unmatched` is what makes the next retry land.
§7.3's 30-day drop bounds it. The alternative — a pending-events table on the
tracker — is more machinery for the same outcome, and worth revisiting only if
the unmatched queue turns out to be large in practice.

### Playback events older than five minutes do not touch sessions

Not in the spec. A plugin flushing an hour of backlog after downtime would
otherwise reopen "now playing" for something that finished long ago. Those
events are *accepted* (not an error — there is nothing for the plugin to fix)
and simply not applied. `item.played` is deliberately exempt: a delayed watch
event is exactly what the outbound queue exists to preserve.

### The session TTL runs on the tracker's clock

§5.3 says `expires_at = now() + 2 minutes`, and `now()` is deliberately the
tracker's. Deriving it from the event's `occurred_at` would be more precise but
puts a member's own clock in charge of their session lifetime — a server
running ten minutes slow would expire every session it opened (C3: the server
is not trusted).

### `is_rewatch` is computed, never sent

Per §5.3, and it matters for the same reason: a server could otherwise mislabel
a member's first watch as a rewatch, or suppress the rewatch announcement.

## Library deltas and snapshots (§6.3)

`apps/web/src/server/library.ts` behind the four §6.3 endpoints. Both paths
funnel their removals through `applyRemovals`, which is why the safety valve is
a separate module.

### `library_entries_identity` had to change — §5.4 is wrong

**This is a deviation from a binding section, raised here.** §5.4 specifies:

```sql
CREATE UNIQUE INDEX library_entries_identity ON library_entries (server_id, jellyfin_item_id);
```

That cannot hold on a server with more than one member. §7.4 runs the snapshot
*per local Jellyfin user*, so a film on LarsFlix arrives once for each linked
member with the same `jellyfin_item_id` — and the second insert collides. The
case it breaks is the one C2 exists for.

Changed to `(server_id, user_id, jellyfin_item_id)`. The index's stated purpose
still holds: §6.3.1 removals carry only a Jellyfin item id, and a delta also
carries `jellyfin_user_id`, so the row is still found without re-resolving
metadata. Migration `0003`.

### `library_syncs`

Not in §5, but §6.3.2 hands out a `sync_id` at `start` and `finish` needs to
know when the run began. State is `open | finished | abandoned`; starting a new
run abandons any open one for that (server, member) rather than resuming it,
because a stale run's confirmations predate the new start and would read as
removals. Abandoning deletes nothing, per §6.3.2.

### Two Jellyfin items for one title

`library_entries_logical` allows one row per title per member per server, but a
member can hold the same film as two Jellyfin items — a `Movies` and a
`Movies 4K` library. The second is a no-op rather than an error: the title is
already available to them. The cost is that removing the recorded copy drops
availability until the next snapshot restores it from the other, which is
exactly the silent gap the snapshot exists to repair (§7.4).

### An unlinked account is refused at `start`, not after 4000 items

§7.4 sends every local Jellyfin account because the plugin cannot know which are
linked, and §6.3.2 says the tracker discards the unlinked ones. Discovering that
at `start` is the same outcome for a fraction of the traffic, so `start` and
`delta` return 409 `unlinked_account` — a "skip this user", not a "retry". The
account row is still upserted first, so the member appears in the owner's
linking UI.

### Profile columns survive the reporting toggle

§7.7's `ReportMediaProfile` opt-out omits `media`. An update that omits it
leaves the existing profile alone rather than nulling it: losing a good profile
is worse than holding a slightly stale one.

## The Jellyfin plugin (§7)

Targets `net8.0` for Jellyfin 10.10's ABI against `Jellyfin.Controller` 10.10.7,
built with whatever SDK is installed (reference assemblies come from NuGet). The
test project targets `net10.0` and references the net8.0 library, so running the
tests does not need a .NET 8 runtime installed.

`Microsoft.Data.Sqlite` 8.0.11 pulls `SQLitePCLRaw` 2.1.6, which carries
GHSA-2m69-gcr7-jv3q — an advisory covering everything up to 2.1.11. Pinned
forward to 2.1.13; `dotnet list package --vulnerable` is clean.

### Queue writes are synchronous, deliberately

§7.3 says never to block a Jellyfin event handler on network IO, and the flush
loop honours that. The SQLite append, though, happens inline on the event
thread: a WAL-mode insert is sub-millisecond, and handing off to a background
writer would open a window in which a crash loses the very events the table
exists to protect.

### `item.played` carries no position

Jellyfin has already applied the member's own completion threshold before
raising `PlaybackFinished`, and commonly resets the stored position on finish.
Reporting `position == runtime` to force `progress_pct` to 100 would be
inventing data, so the field is left null and the event itself is the signal.

### A refused payload is dropped, not retried forever

The flush loop treats 401, 408, 429 and 5xx as retryable and everything else in
the 4xx range as permanent. A payload the tracker understood and refused would
otherwise wedge the queue behind it indefinitely — §7.3's ordering guarantee
means nothing behind it would ever be sent either.

### Packaging ships SQLite, trimmed

`Jellyfin.Controller` does not bring `Microsoft.Data.Sqlite`, so the plugin
ships its own. The native build covers every RID .NET knows about — about 32MB
of architectures no Jellyfin server runs on — so `build-plugin.sh` keeps only
linux x64/arm64 (glibc and musl), win-x64 and macOS, taking the package to
5.5MB.

Worth watching on first install: the Jellyfin *server* also uses
`Microsoft.Data.Sqlite`, so both copies are present in the process. Managed
assemblies unify in the default load context and `Batteries_V2.Init()` is
idempotent, so this should be fine — but if the plugin ever fails to load with
a SQLite type or native-library conflict, the fix is to mark the package
reference `ExcludeAssets="runtime"` and rely on the host's copy.

### The snapshot bypasses the outbound queue

Deltas go through the queue (§7.4 says so explicitly). The full snapshot does
not: it is only meaningful while its `sync_id` is open, and a stale snapshot
replayed hours later would reconcile against a library that has since changed.
A failed snapshot is simply abandoned — §6.3.2 guarantees that deletes nothing
— and the next nightly run starts clean.

### Dolby Vision variants all report as DV

Jellyfin's `VideoRangeType` distinguishes `DOVI`, `DOVIWithHDR10`,
`DOVIWithHLG` and `DOVIWithSDR`; §5.4 stores one of SDR, HDR10, HDR10+, DV or
HLG. All four map to `DV`: a player that handles Dolby Vision handles them, and
the fallback layer is not what decides whether the group can watch together.

## Test infrastructure

There was none before M2. `packages/db/src/testing.ts` (`@media-tracker/db/testing`)
creates a throwaway database per test file, applies the real migrations to it —
not `drizzle-kit push`, so tests exercise the SQL production runs — and drops it
afterwards. Integration tests skip rather than fail when `DATABASE_URL` is
absent, so `pnpm test` works on a machine with no Postgres.

`next lint` was replaced with the ESLint CLI and a flat config at the repo root:
it is deprecated in Next 15, removed in Next 16, and could not lint `packages/`
at all.

## `.env` is only loaded by Next

Worth knowing, because it bit three separate entry points: the `.env` symlinks
make the file *present*, but only `next` reads one on its own. `drizzle-kit`,
`tsx`, and `vitest` all need to be told. So `packages/db` loads it in
`drizzle.config.ts`, the worker's `dev`/`start` scripts pass
`--env-file-if-exists=.env`, and `vitest.shared.ts` loads it for tests. The
`-if-exists` form matters: production containers get environment variables and
ship no file, and must not fail on its absence.
