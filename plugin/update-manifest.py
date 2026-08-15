"""Adds or replaces a release in plugin/manifest.json (S7.8).

Rewriting JSON from shell is a trap, so the manifest has one owner: this.
"""

import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]
checksum = sys.argv[3]
timestamp = sys.argv[4]
source_url = sys.argv[5]

manifest = json.loads(path.read_text())
versions = manifest[0]["versions"]

entry = {
    "version": version,
    "changelog": "",
    "targetAbi": os.environ.get("TARGET_ABI", "10.10.0.0"),
    "sourceUrl": source_url,
    "checksum": checksum,
    "timestamp": timestamp,
}

existing = next((v for v in versions if v["version"] == version), None)
if existing:
    # Replace rather than append: two entries for one version with different
    # checksums would leave Jellyfin picking whichever it saw first.
    entry["changelog"] = existing.get("changelog", "")
    versions[versions.index(existing)] = entry
else:
    versions.append(entry)

versions.sort(key=lambda v: v["timestamp"], reverse=True)
path.write_text(json.dumps(manifest, indent=2) + "\n")
print(f"manifest updated: {len(versions)} version(s)")
