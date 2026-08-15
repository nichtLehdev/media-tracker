import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { env } from '@/env';

export const dynamic = 'force-dynamic';

/**
 * S7.8. The plugin repository manifest. A member adds this URL once under
 * Dashboard -> Plugins -> Repositories and gets updates automatically, which
 * is the point: assume nobody updates manually.
 *
 * Releases are committed to `releases.json` by the packaging script
 * (`plugin/build-plugin.sh`), which is what produces the checksum Jellyfin
 * verifies on install.
 */

const PLUGIN_GUID = '8f1a2c4e-5b3d-4f6a-9c8e-1d2b3a4c5e6f';

const release = z.object({
  version: z.string(),
  changelog: z.string().default(''),
  targetAbi: z.string(),
  /** File name under /plugin; the absolute URL is built from PUBLIC_BASE_URL. */
  file: z.string(),
  checksum: z.string(),
  timestamp: z.string(),
});

const releasesFile = z.object({ releases: z.array(release).default([]) });

export async function GET(): Promise<Response> {
  const raw = await readFile(
    path.join(process.cwd(), 'src/app/plugin/releases.json'),
    'utf8',
  ).catch(() => '{"releases":[]}');

  const parsed = releasesFile.safeParse(JSON.parse(raw));
  const releases = parsed.success ? parsed.data.releases : [];

  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');

  const manifest = [
    {
      guid: PLUGIN_GUID,
      name: 'Tracker',
      description:
        'Reports watch activity and library inventory to a self-hosted media tracker.',
      overview: 'Watch tracking for a Discord community.',
      owner: 'media-tracker',
      category: 'General',
      versions: releases
        // Newest first: Jellyfin offers the first entry it finds for the ABI.
        .slice()
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .map((r) => ({
          version: r.version,
          changelog: r.changelog,
          targetAbi: r.targetAbi,
          sourceUrl: `${base}/plugin/${r.file}`,
          checksum: r.checksum,
          timestamp: r.timestamp,
        })),
    },
  ];

  return Response.json(manifest, {
    headers: {
      // Jellyfin polls this; a short cache keeps a release visible quickly
      // without hammering the app.
      'cache-control': 'public, max-age=300',
    },
  });
}
