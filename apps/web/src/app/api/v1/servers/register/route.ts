import {
  serverRegisterRequest,
  type ServerRegisterResponse,
} from '@media-tracker/contracts';
import { and, db, eq, isNull, newId, schema, sql } from '@media-tracker/db';
import { json, parseBody, problem } from '@/server/api';
import { clientAddress, rateLimit } from '@/server/rate-limit';
import { hashRegistrationCode, issueServerToken } from '@/server/secrets';

export const dynamic = 'force-dynamic';

/**
 * S6.1. The owner generates a code on the website and pastes it into the
 * plugin's config page. Codes are single-use and expire in 15 minutes; the
 * returned secret is shown exactly once and stored argon2id-hashed.
 */
export async function POST(req: Request): Promise<Response> {
  // A registration code is only 40 bits, so guessing has to be made expensive
  // at the endpoint rather than in the code itself.
  const limit = rateLimit(`register:${clientAddress(req)}`, 10, 60_000);
  if (!limit.ok) {
    return problem(429, 'rate_limited', {
      retry_after: limit.retryAfterSeconds,
    });
  }

  const parsed = await parseBody(req, serverRegisterRequest);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const codeHash = hashRegistrationCode(body.registration_code);
  const serverId = newId();
  const { token, hash } = await issueServerToken(serverId);

  try {
    await db().transaction(async (tx) => {
      // Claim the code first: the conditional UPDATE is what makes it
      // single-use even if two plugins race with the same code. The whole
      // block is one transaction, so a later failure hands the code back.
      const claimed = await tx
        .update(schema.registrationCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.registrationCodes.codeHash, codeHash),
            isNull(schema.registrationCodes.usedAt),
            sql`${schema.registrationCodes.expiresAt} > now()`,
          ),
        )
        .returning({
          id: schema.registrationCodes.id,
          ownerUserId: schema.registrationCodes.ownerUserId,
        });

      const code = claimed[0];
      if (!code) throw new InvalidCodeError();

      await tx.insert(schema.servers).values({
        id: serverId,
        ownerUserId: code.ownerUserId,
        name: body.name,
        secretHash: hash,
        pluginVersion: body.plugin_version ?? null,
        jellyfinVersion: body.jellyfin_version ?? null,
        lastSeenAt: new Date(),
      });

      // Only now: registration_codes.server_id is a foreign key, so it cannot
      // be set before the row it points at exists.
      await tx
        .update(schema.registrationCodes)
        .set({ serverId })
        .where(eq(schema.registrationCodes.id, code.id));
    });
  } catch (err) {
    if (err instanceof InvalidCodeError) {
      return problem(400, 'invalid_registration_code');
    }
    throw err;
  }

  const response: ServerRegisterResponse = {
    server_id: serverId,
    server_secret: token,
  };
  return json(response);
}

class InvalidCodeError extends Error {}
