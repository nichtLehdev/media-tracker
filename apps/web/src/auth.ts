import NextAuth, { type DefaultSession } from 'next-auth';
import Discord from 'next-auth/providers/discord';
import { env } from '@/env';
import { discordAvatarUrl, isGuildMember } from '@/server/discord';
import { upsertUserFromDiscord } from '@/server/users';

declare module 'next-auth' {
  interface Session {
    user: {
      /** Tracker user id (users.id), not the Discord snowflake. */
      id: string;
      discordId: string;
    } & DefaultSession['user'];
  }
}

/**
 * Fields this app puts on the session JWT. Declared locally rather than as a
 * `next-auth/jwt` module augmentation, which TypeScript refuses to resolve
 * under this module resolution mode.
 */
interface TrackerClaims {
  userId?: string;
  discordId?: string;
}

/**
 * Discord is the only provider, and guild membership is checked on every
 * sign-in (S15).
 *
 * Known limitation: sessions are JWTs, so a member removed from the guild
 * keeps access until their session expires. `maxAge` below is the dial for
 * that window. Closing it entirely needs either the Discord OAuth token kept
 * for periodic re-checks, or a bot token to query membership server-side --
 * neither is in the S4 configuration, so it is deliberately left open.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: env.AUTH_SECRET,
  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60,
  },
  pages: {
    signIn: '/signin',
    error: '/signin',
  },
  providers: [
    Discord({
      clientId: env.AUTH_DISCORD_ID,
      clientSecret: env.AUTH_DISCORD_SECRET,
      authorization: { params: { scope: 'identify guilds' } },
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== 'discord') return false;
      const accessToken = account.access_token;
      if (!accessToken || !profile?.id) return false;

      try {
        if (!(await isGuildMember(accessToken, env.DISCORD_GUILD_ID))) {
          return false;
        }
      } catch (err) {
        // Fail closed: an unreachable Discord is not proof of membership.
        console.error('guild membership check failed', err);
        return false;
      }

      await upsertUserFromDiscord({
        discordId: String(profile.id),
        displayName:
          (profile.global_name as string | null) ??
          (profile.username as string | undefined) ??
          'Unknown',
        avatarUrl: discordAvatarUrl(
          String(profile.id),
          profile.avatar as string | null,
        ),
      });

      return true;
    },

    async jwt({ token, profile }) {
      const claims = token as typeof token & TrackerClaims;
      if (profile?.id) {
        claims.discordId = String(profile.id);
        claims.userId = await upsertUserFromDiscord({
          discordId: String(profile.id),
          displayName:
            (profile.global_name as string | null) ??
            (profile.username as string | undefined) ??
            'Unknown',
          avatarUrl: discordAvatarUrl(
            String(profile.id),
            profile.avatar as string | null,
          ),
        });
      }
      return claims;
    },

    async session({ session, token }) {
      const claims = token as typeof token & TrackerClaims;
      if (claims.userId && claims.discordId) {
        session.user = {
          ...session.user,
          id: claims.userId,
          discordId: claims.discordId,
        };
      }
      return session;
    },
  },
});
