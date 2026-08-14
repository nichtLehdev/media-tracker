import { redirect } from 'next/navigation';
import { auth, signIn } from '@/auth';

const MESSAGES: Record<string, string> = {
  AccessDenied:
    'That Discord account is not a member of the community guild, so it cannot sign in here.',
  Configuration:
    'Discord sign-in is misconfigured on the server. Check AUTH_DISCORD_ID and AUTH_DISCORD_SECRET.',
  Verification: 'That sign-in link is no longer valid. Try again.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect('/');

  const { error, callbackUrl } = await searchParams;

  return (
    <main>
      <h1>Sign in</h1>
      <p className="lede">
        Access is limited to members of the community Discord guild.
      </p>

      {error ? (
        <div className="notice error">
          {MESSAGES[error] ?? 'Sign-in failed. Try again.'}
        </div>
      ) : null}

      <form
        action={async () => {
          'use server';
          await signIn('discord', { redirectTo: callbackUrl ?? '/' });
        }}
      >
        <button className="primary" type="submit">
          Continue with Discord
        </button>
      </form>
    </main>
  );
}
