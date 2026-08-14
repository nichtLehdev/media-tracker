import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { env } from '@/env';

const b64url = (buf: Buffer) => buf.toString('base64url');

// --- server bearer tokens (S6.1) ------------------------------------------

/**
 * The token carries the server id in its first segment so a request can be
 * resolved to exactly one row before the argon2 verify. Without it, every
 * request would have to verify against every server's hash.
 *
 * The id is not a secret; the second segment is 256 bits of entropy and is
 * what actually authenticates.
 */
export interface IssuedServerToken {
  token: string;
  hash: string;
}

/**
 * @node-rs/argon2's `Algorithm` is an ambient const enum, which cannot be
 * imported under verbatimModuleSyntax -- hence the literal. Argon2id is also
 * this library's default, so the value is belt and braces rather than the
 * only thing selecting the algorithm.
 */
const ALGORITHM_ARGON2ID = 2;

const ARGON_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
} as const;

export async function issueServerToken(
  serverId: string,
): Promise<IssuedServerToken> {
  const secret = b64url(randomBytes(32));
  const token = `${b64url(Buffer.from(serverId.replaceAll('-', ''), 'hex'))}.${secret}`;
  return { token, hash: await argonHash(secret, ARGON_OPTIONS) };
}

export function parseServerToken(
  token: string,
): { serverId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const idPart = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!secret) return null;

  let raw: Buffer;
  try {
    raw = Buffer.from(idPart, 'base64url');
  } catch {
    return null;
  }
  if (raw.length !== 16) return null;

  const hex = raw.toString('hex');
  const serverId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');

  return { serverId, secret };
}

export function verifyServerSecret(
  storedHash: string,
  secret: string,
): Promise<boolean> {
  return argonVerify(storedHash, secret).catch(() => false);
}

// --- registration codes (S6.1) --------------------------------------------

/** Crockford-ish alphabet: no I, L, O, 0, 1 to survive being read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRegistrationCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(
    bytes,
    (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!,
  );
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Codes are stored hashed so a database read does not hand out live codes.
 * SHA-256 rather than argon2 is fine here: the lookup is by hash, the code
 * dies in 15 minutes, and the endpoint is rate limited.
 */
export function hashRegistrationCode(code: string): string {
  return createHash('sha256')
    .update(code.trim().toUpperCase(), 'utf8')
    .digest('hex');
}

// --- account link invites (S8) --------------------------------------------

interface InvitePayload {
  /** server id */
  s: string;
  /** jellyfin user id */
  j: string;
  /** expiry, epoch seconds */
  e: number;
}

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const INVITE_DOMAIN = 'account-link-invite.v1';

function sign(data: string): string {
  return createHmac('sha256', env.AUTH_SECRET)
    .update(`${INVITE_DOMAIN}:${data}`)
    .digest('base64url');
}

export function createInviteToken(
  serverId: string,
  jellyfinUserId: string,
  ttlSeconds = INVITE_TTL_SECONDS,
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const payload: InvitePayload = {
    s: serverId,
    j: jellyfinUserId,
    e: Math.floor(expiresAt.getTime() / 1000),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { token: `${body}.${sign(body)}`, expiresAt };
}

export function readInviteToken(
  token: string,
): { serverId: string; jellyfinUserId: string } | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(body), 'base64url');
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let payload: InvitePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.s !== 'string' || typeof payload?.j !== 'string') {
    return null;
  }
  if (!Number.isFinite(payload.e) || payload.e * 1000 < Date.now()) return null;

  return { serverId: payload.s, jellyfinUserId: payload.j };
}
