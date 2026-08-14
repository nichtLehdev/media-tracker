import { createHash } from 'node:crypto';
import { db, eq, schema } from '@media-tracker/db';
import { parseServerToken, verifyServerSecret } from './secrets';
import { problem } from './api';

export interface AuthedServer {
  id: string;
  ownerUserId: string;
  name: string;
}

/**
 * argon2id verification costs tens of milliseconds, and the plugin hits ingest
 * continuously. Successful verifications are cached against a SHA-256 of the
 * presented token so only the first request in each window pays for it.
 *
 * Revocation still takes effect within TTL_MS because the cached entry is
 * re-checked against `revoked_at` on every use.
 */
const TTL_MS = 5 * 60 * 1000;
const verified = new Map<string, { serverId: string; expiresAt: number }>();

const fingerprint = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

export type ServerAuthResult =
  | { ok: true; server: AuthedServer }
  | { ok: false; response: Response };

export async function authenticateServer(
  req: Request,
): Promise<ServerAuthResult> {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return { ok: false, response: unauthorized() };
  }
  const token = header.slice('Bearer '.length).trim();
  const parsed = parseServerToken(token);
  if (!parsed) return { ok: false, response: unauthorized() };

  const [row] = await db()
    .select({
      id: schema.servers.id,
      ownerUserId: schema.servers.ownerUserId,
      name: schema.servers.name,
      secretHash: schema.servers.secretHash,
      revokedAt: schema.servers.revokedAt,
    })
    .from(schema.servers)
    .where(eq(schema.servers.id, parsed.serverId))
    .limit(1);

  // A revoked or unknown server is a 401 either way -- do not leak which.
  if (!row || row.revokedAt) return { ok: false, response: unauthorized() };

  const fp = fingerprint(token);
  const cached = verified.get(fp);
  const now = Date.now();

  if (!cached || cached.expiresAt <= now || cached.serverId !== row.id) {
    const valid = await verifyServerSecret(row.secretHash, parsed.secret);
    if (!valid) {
      verified.delete(fp);
      return { ok: false, response: unauthorized() };
    }
    verified.set(fp, { serverId: row.id, expiresAt: now + TTL_MS });
  }

  return {
    ok: true,
    server: { id: row.id, ownerUserId: row.ownerUserId, name: row.name },
  };
}

/**
 * Records liveness and the reported versions. Throttled, because ingest can
 * arrive every few seconds and this would otherwise be a write per request.
 */
const lastHeartbeat = new Map<string, number>();
const HEARTBEAT_INTERVAL_MS = 60_000;

export async function recordServerHeartbeat(
  serverId: string,
  req: Request,
): Promise<void> {
  const now = Date.now();
  const previous = lastHeartbeat.get(serverId) ?? 0;
  if (now - previous < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeat.set(serverId, now);

  const pluginVersion = req.headers.get('x-plugin-version');
  const jellyfinVersion = req.headers.get('x-jellyfin-version');

  await db()
    .update(schema.servers)
    .set({
      lastSeenAt: new Date(),
      ...(pluginVersion ? { pluginVersion } : {}),
      ...(jellyfinVersion ? { jellyfinVersion } : {}),
    })
    .where(eq(schema.servers.id, serverId));
}

function unauthorized(): Response {
  return problem(401, 'unauthorized');
}
