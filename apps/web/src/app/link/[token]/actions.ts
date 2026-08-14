'use server';

import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { acceptInvite, declineInvite, LinkingError } from '@/server/linking';

export interface LinkResult {
  status: 'idle' | 'linked' | 'declined' | 'error';
  error?: string;
}

export async function acceptInviteAction(
  _prev: LinkResult,
  formData: FormData,
): Promise<LinkResult> {
  const session = await auth();
  const token = String(formData.get('token') ?? '');
  if (!session?.user?.id) {
    redirect(`/signin?callbackUrl=/link/${encodeURIComponent(token)}`);
  }

  try {
    await acceptInvite(token, session.user.id);
    return { status: 'linked' };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof LinkingError ? err.code : 'link_failed',
    };
  }
}

export async function declineInviteAction(
  _prev: LinkResult,
  formData: FormData,
): Promise<LinkResult> {
  const session = await auth();
  const token = String(formData.get('token') ?? '');
  if (!session?.user?.id) {
    redirect(`/signin?callbackUrl=/link/${encodeURIComponent(token)}`);
  }

  try {
    await declineInvite(token);
    return { status: 'declined' };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof LinkingError ? err.code : 'link_failed',
    };
  }
}
