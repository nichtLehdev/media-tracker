#!/usr/bin/env bash
# Packages the plugin for installation (S7.8).
#
# Without --publish this only builds dist/tracker_<version>.zip and prints its
# checksum. With --publish it also copies the zip to where the web app serves
# it and records it in the manifest, which is the pair Jellyfin needs: it
# verifies the download against the checksum in the manifest.
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:-1.0.0.0}"
PUBLISH="${2:-}"
# Absolute, because Jellyfin fetches the manifest and the zip separately.
BASE_URL="${BASE_URL:-https://tracker.lehdev.de}"

OUT="dist"
STAGE="$OUT/stage"
SERVED="../apps/web/public/plugin"

rm -rf "$OUT"
mkdir -p "$STAGE"

dotnet publish Jellyfin.Plugin.Tracker/Jellyfin.Plugin.Tracker.csproj \
  -c Release \
  -p:Version="$VERSION" \
  -o "$STAGE" \
  --nologo

# Ship the plugin and its SQLite dependency only. Jellyfin's own assemblies
# come from the host; shipping copies would shadow them.
find "$STAGE" -maxdepth 1 -type f \
  ! -name 'Jellyfin.Plugin.Tracker.dll' \
  ! -name 'Microsoft.Data.Sqlite.dll' \
  ! -name 'SQLitePCLRaw.*.dll' \
  -delete

# The native SQLite build ships for every RID .NET knows about, which is ~32MB
# of architectures no Jellyfin server runs on. Keep the ones that exist in the
# wild: Docker on x64/arm64 (glibc and musl), Windows, and macOS.
KEEP=(linux-x64 linux-arm64 linux-musl-x64 linux-musl-arm64 win-x64 osx-x64 osx-arm64)
if [ -d "$STAGE/runtimes" ]; then
  for rid in "$STAGE"/runtimes/*/; do
    name=$(basename "$rid")
    keep=false
    for wanted in "${KEEP[@]}"; do
      [ "$name" = "$wanted" ] && keep=true
    done
    $keep || rm -rf "$rid"
  done
fi

( cd "$STAGE" && zip -qr "../tracker_${VERSION}.zip" . )
rm -rf "$STAGE"

CHECKSUM=$(md5 -q "$OUT/tracker_${VERSION}.zip" 2>/dev/null \
  || md5sum "$OUT/tracker_${VERSION}.zip" | cut -d' ' -f1)

echo "built  $OUT/tracker_${VERSION}.zip"
echo "md5    $CHECKSUM"

if [ "$PUBLISH" != "--publish" ]; then
  echo
  echo "Not published. Re-run with --publish to copy the zip into"
  echo "apps/web/public/plugin/ and record it in manifest.json."
  exit 0
fi

mkdir -p "$SERVED"
cp "$OUT/tracker_${VERSION}.zip" "$SERVED/"
python3 update-manifest.py \
  "$SERVED/manifest.json" \
  "$VERSION" \
  "$CHECKSUM" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$BASE_URL"

echo "published to apps/web/public/plugin/"
