Served as-is at `$PUBLIC_BASE_URL/plugin/`.

`manifest.json` is the Jellyfin plugin repository (S7.8) — the URL a member
adds once under Dashboard → Plugins → Repositories. The zips beside it are what
Jellyfin then downloads; it checks each against the `checksum` in the manifest,
so the two are written together by `plugin/build-plugin.sh --publish` rather
than edited by hand.

`sourceUrl` is absolute because Jellyfin fetches the manifest and the zip as
separate requests. Override the host with `BASE_URL=... ./build-plugin.sh`.
