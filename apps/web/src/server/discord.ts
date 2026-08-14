const DISCORD_API = 'https://discord.com/api/v10';

export interface PartialGuild {
  id: string;
  name: string;
}

/**
 * S15: sign-in is restricted to members of DISCORD_GUILD_ID, and that is
 * verified against Discord rather than inferred from having a Discord account.
 *
 * Throws on a transport failure so the caller can fail *closed* -- an
 * unreachable Discord must not be read as "not a member" or as "a member".
 */
export async function fetchUserGuilds(
  accessToken: string,
): Promise<PartialGuild[]> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`discord /users/@me/guilds returned ${res.status}`);
  }
  return (await res.json()) as PartialGuild[];
}

export async function isGuildMember(
  accessToken: string,
  guildId: string,
): Promise<boolean> {
  const guilds = await fetchUserGuilds(accessToken);
  return guilds.some((g) => g.id === guildId);
}

export function discordAvatarUrl(
  userId: string,
  avatarHash: string | null | undefined,
): string | null {
  if (!avatarHash) return null;
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=128`;
}
