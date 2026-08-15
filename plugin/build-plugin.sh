#!/usr/bin/env bash
# Packages the plugin for installation (S7.8).
#
# The manifest and the zips are both served by GitHub, not by the web app:
# manifest.json is read straight from the repo, and each zip is a GitHub
# release asset. So --publish only records the release here; uploading the zip
# to the matching tag is a separate step (see README).
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:-1.0.0.0}"
PUBLISH="${2:-}"
# Where Jellyfin will download the zip from. Must match the tag the asset is
# uploaded to, or the install fails after the manifest resolves.
RELEASES="${RELEASES:-https://github.com/nichtLehdev/media-tracker/releases/download}"

OUT="dist"
STAGE="$OUT/stage"
MANIFEST="manifest.json"

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
SOURCE_URL="${RELEASES}/v${VERSION}/tracker_${VERSION}.zip"

echo "built  $OUT/tracker_${VERSION}.zip"
echo "md5    $CHECKSUM"

if [ "$PUBLISH" != "--publish" ]; then
  echo
  echo "Not published. Re-run with --publish to record it in manifest.json."
  exit 0
fi

python3 update-manifest.py \
  "$MANIFEST" "$VERSION" "$CHECKSUM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SOURCE_URL"

cat <<NEXT

Now publish the asset, or the manifest points at a 404:

  gh release create v${VERSION} ${OUT}/tracker_${VERSION}.zip

Then commit manifest.json and push. Jellyfin reads the manifest from the
repo, so it only sees the release once that push lands.
NEXT
