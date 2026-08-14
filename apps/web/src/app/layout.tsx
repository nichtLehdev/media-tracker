import type { Metadata } from 'next';
import Link from 'next/link';
import { auth, signOut } from '@/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'Media Tracker',
  description: 'Watch tracking across the community"s Jellyfin servers',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <Link className="brand" href="/">
              Media Tracker
            </Link>
            {session?.user ? (
              <>
                <Link href="/settings/servers">Servers</Link>
                <span className="spacer" />
                <span style={{ color: 'var(--muted)', fontSize: 14 }}>
                  {session.user.name}
                </span>
                <form
                  action={async () => {
                    'use server';
                    await signOut({ redirectTo: '/signin' });
                  }}
                >
                  <button type="submit">Sign out</button>
                </form>
              </>
            ) : (
              <span className="spacer" />
            )}
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
