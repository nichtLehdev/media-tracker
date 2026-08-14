/**
 * M1 acceptance check (S18): register a server via the API and link a Jellyfin
 * account end to end.
 *
 * The Discord OAuth round trip is the one step this cannot drive -- it needs
 * live credentials -- so the member is seeded directly and everything after
 * sign-in is exercised for real, over HTTP where the plugin would use HTTP.
 *
 *   pnpm --filter @media-tracker/web exec tsx scripts/e2e-m1.ts
 */
import { randomUUID } from 'node:crypto';
import { and, db, eq, newId, schema } from '@media-tracker/db';
import {
  acceptInvite,
  createInvite,
  LinkingError,
  listServerAccounts,
  unlinkAccount,
} from '../src/server/linking';
import {
  generateRegistrationCode,
  hashRegistrationCode,
} from '../src/server/secrets';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`, detail ?? '');
  }
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const database = db();

  console.log('\n1. seed a member (stands in for Discord sign-in)');
  const [owner] = await database
    .insert(schema.users)
    .values({
      id: newId(),
      discordId: `e2e-owner-${run}`,
      displayName: `E2E Owner ${run}`,
    })
    .returning({ id: schema.users.id });
  const [member] = await database
    .insert(schema.users)
    .values({
      id: newId(),
      discordId: `e2e-member-${run}`,
      displayName: `E2E Member ${run}`,
    })
    .returning({ id: schema.users.id });
  check('owner and member rows created', !!owner && !!member);

  console.log('\n2. owner generates a registration code (S6.1)');
  const code = generateRegistrationCode();
  await database.insert(schema.registrationCodes).values({
    id: newId(),
    codeHash: hashRegistrationCode(code),
    ownerUserId: owner!.id,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  check('code matches the documented ABCD-EFGH shape', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));

  console.log('\n3. plugin registers the server over HTTP');
  const registerRes = await fetch(`${BASE}/api/v1/servers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      registration_code: code,
      name: `E2E Flix ${run}`,
      jellyfin_version: '10.10.3',
      plugin_version: '1.0.0',
    }),
  });
  const registered = (await registerRes.json()) as {
    server_id?: string;
    server_secret?: string;
  };
  check('register returns 200', registerRes.status === 200, registerRes.status);
  check('server_id returned', !!registered.server_id);
  check('server_secret returned', !!registered.server_secret);

  const serverId = registered.server_id!;
  const secret = registered.server_secret!;

  console.log('\n4. the code is single-use');
  const replay = await fetch(`${BASE}/api/v1/servers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registration_code: code, name: 'replay' }),
  });
  check('replayed code is rejected', replay.status === 400, replay.status);

  console.log('\n5. bearer auth on plugin endpoints');
  const badAuth = await fetch(`${BASE}/api/v1/accounts/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer not-a-real-token',
    },
    body: JSON.stringify({ accounts: [] }),
  });
  check('garbage token gets 401', badAuth.status === 401, badAuth.status);

  const wrongSecret = `${secret.split('.')[0]}.${'x'.repeat(43)}`;
  const badSecret = await fetch(`${BASE}/api/v1/accounts/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${wrongSecret}`,
    },
    body: JSON.stringify({ accounts: [] }),
  });
  check('right server id with wrong secret gets 401', badSecret.status === 401, badSecret.status);

  console.log('\n6. plugin reports its Jellyfin accounts (S7.5)');
  const jellyfinUserId = `jf-${run}`;
  const reportRes = await fetch(`${BASE}/api/v1/accounts/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'x-plugin-version': '1.0.0',
    },
    body: JSON.stringify({
      accounts: [
        { jellyfin_user_id: jellyfinUserId, jellyfin_username: 'anna' },
        { jellyfin_user_id: `jf-other-${run}`, jellyfin_username: 'family-tv' },
      ],
    }),
  });
  const reported = (await reportRes.json()) as {
    accounts: Array<{ jellyfin_user_id: string; link_state: string }>;
  };
  check('report returns 200', reportRes.status === 200, reportRes.status);
  check('both accounts echoed back', reported.accounts?.length === 2, reported.accounts?.length);
  check(
    'accounts start unlinked',
    reported.accounts?.every((a) => a.link_state === 'unlinked'),
    reported.accounts,
  );

  console.log('\n7. owner invites the member (S8)');
  const inviteRes = await fetch(`${BASE}/api/v1/accounts/invite`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jellyfin_user_id: jellyfinUserId }),
  });
  const invite = (await inviteRes.json()) as { invite_url?: string };
  check('invite returns 200', inviteRes.status === 200, inviteRes.status);
  check('invite url returned', !!invite.invite_url, invite);

  const inviteToken = invite.invite_url!.split('/link/')[1]!;

  const afterInvite = await listServerAccounts(serverId);
  check(
    'invited account is pending',
    afterInvite.find((a) => a.jellyfinUserId === jellyfinUserId)?.linkState === 'pending',
  );

  console.log('\n8. the link page requires the member to be signed in (S15)');
  // The invite URL is built from PUBLIC_BASE_URL, which points at the real
  // deployment; follow the same token against the instance under test.
  const anonymous = await fetch(`${BASE}/link/${inviteToken}`, {
    redirect: 'manual',
  });
  const location = anonymous.headers.get('location') ?? '';
  check(
    'anonymous visitor is redirected to sign-in',
    anonymous.status >= 300 && anonymous.status < 400 && location.includes('/signin'),
    `${anonymous.status} ${location}`,
  );

  console.log('\n9. member accepts, completing the two-sided consent');
  await acceptInvite(inviteToken, member!.id);
  const afterAccept = await listServerAccounts(serverId);
  const linkedRow = afterAccept.find((a) => a.jellyfinUserId === jellyfinUserId);
  check('link_state is linked', linkedRow?.linkState === 'linked', linkedRow);
  check('linked to the accepting member', linkedRow?.linkedUserId === member!.id);

  console.log('\n10. a second member cannot claim the same account');
  const [intruder] = await database
    .insert(schema.users)
    .values({
      id: newId(),
      discordId: `e2e-intruder-${run}`,
      displayName: `E2E Intruder ${run}`,
    })
    .returning({ id: schema.users.id });
  let claimRejected = false;
  try {
    await acceptInvite(inviteToken, intruder!.id);
  } catch (err) {
    claimRejected = err instanceof LinkingError && err.code === 'claimed_by_another_member';
  }
  check('second claim is refused', claimRejected);

  console.log('\n11. re-reporting cannot change a link state (C2)');
  await fetch(`${BASE}/api/v1/accounts/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      accounts: [{ jellyfin_user_id: jellyfinUserId, jellyfin_username: 'renamed' }],
    }),
  });
  const afterReport = await listServerAccounts(serverId);
  const stillLinked = afterReport.find((a) => a.jellyfinUserId === jellyfinUserId);
  check('still linked after a re-report', stillLinked?.linkState === 'linked');
  check('username updated by the report', stillLinked?.jellyfinUsername === 'renamed');

  console.log('\n12. inviting an already-linked account is a conflict');
  let conflict = false;
  try {
    await createInvite(serverId, jellyfinUserId);
  } catch (err) {
    conflict = err instanceof LinkingError && err.code === 'already_linked';
  }
  check('re-invite refused while linked', conflict);

  console.log('\n13. unlinking stops ingest without deleting history (S8)');
  await unlinkAccount(serverId, jellyfinUserId);
  const afterUnlink = await listServerAccounts(serverId);
  const unlinked = afterUnlink.find((a) => a.jellyfinUserId === jellyfinUserId);
  check('link_state is rejected', unlinked?.linkState === 'rejected');
  check('member association cleared', unlinked?.linkedUserId === null);

  console.log('\n14. a revoked server stops authenticating');
  await database
    .update(schema.servers)
    .set({ revokedAt: new Date() })
    .where(eq(schema.servers.id, serverId));
  const afterRevoke = await fetch(`${BASE}/api/v1/accounts/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ accounts: [] }),
  });
  check('revoked server gets 401', afterRevoke.status === 401, afterRevoke.status);

  console.log('\n15. health endpoint');
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = (await health.json()) as { status?: string };
  check('health is ok', health.status === 200 && healthBody.status === 'ok', healthBody);

  // cleanup
  await database
    .delete(schema.serverAccounts)
    .where(eq(schema.serverAccounts.serverId, serverId));
  await database
    .delete(schema.registrationCodes)
    .where(eq(schema.registrationCodes.ownerUserId, owner!.id));
  await database.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await database
    .delete(schema.users)
    .where(
      and(
        eq(schema.users.discordId, `e2e-owner-${run}`),
      ),
    );
  for (const discordId of [`e2e-member-${run}`, `e2e-intruder-${run}`]) {
    await database.delete(schema.users).where(eq(schema.users.discordId, discordId));
  }

  console.log(
    failures === 0
      ? '\nM1 acceptance: all checks passed\n'
      : `\nM1 acceptance: ${failures} check(s) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
