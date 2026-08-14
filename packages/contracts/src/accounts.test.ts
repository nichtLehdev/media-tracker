import { describe, expect, it } from 'vitest';
import {
  accountInviteResponse,
  accountsReportRequest,
  accountsReportResponse,
  linkState,
  reportedAccount,
} from './accounts.js';

describe('linkState', () => {
  it('accepts the four documented states', () => {
    for (const state of ['unlinked', 'pending', 'linked', 'rejected']) {
      expect(linkState.safeParse(state).success).toBe(true);
    }
  });

  it('rejects an undocumented state', () => {
    expect(linkState.safeParse('revoked').success).toBe(false);
  });
});

describe('reportedAccount', () => {
  it('requires jellyfin_user_id but allows jellyfin_username to be nullish', () => {
    expect(
      reportedAccount.safeParse({ jellyfin_user_id: 'f1c2' }).success,
    ).toBe(true);
    expect(reportedAccount.safeParse({}).success).toBe(false);
  });
});

describe('accountsReportRequest', () => {
  it('rejects an accounts array over the 500-item cap', () => {
    const accounts = Array.from({ length: 501 }, (_, i) => ({
      jellyfin_user_id: `user-${i}`,
    }));
    expect(accountsReportRequest.safeParse({ accounts }).success).toBe(
      false,
    );
  });

  it('accepts an empty accounts array', () => {
    expect(accountsReportRequest.safeParse({ accounts: [] }).success).toBe(
      true,
    );
  });
});

describe('accountsReportResponse', () => {
  it('requires jellyfin_username and linked_display_name to be present (nullable, not optional)', () => {
    const withoutUsername = {
      accounts: [
        {
          jellyfin_user_id: 'f1c2',
          link_state: 'linked' as const,
          linked_display_name: 'lars',
        },
      ],
    };
    expect(accountsReportResponse.safeParse(withoutUsername).success).toBe(
      false,
    );
  });

  it('round-trips a full response with explicit nulls', () => {
    const input = {
      accounts: [
        {
          jellyfin_user_id: 'f1c2',
          jellyfin_username: null,
          link_state: 'pending' as const,
          linked_display_name: null,
        },
      ],
    };
    expect(accountsReportResponse.parse(input)).toEqual(input);
  });
});

describe('accountInviteResponse', () => {
  it('requires invite_url to be a valid URL', () => {
    expect(
      accountInviteResponse.safeParse({
        invite_url: 'not-a-url',
        expires_at: '2026-08-13T20:11:04Z',
      }).success,
    ).toBe(false);
  });

  it('requires expires_at to be an offset timestamp', () => {
    expect(
      accountInviteResponse.safeParse({
        invite_url: 'https://tracker.lehdev.de/link/abc',
        expires_at: '2026-08-13T20:11:04Z',
      }).success,
    ).toBe(true);
  });
});
