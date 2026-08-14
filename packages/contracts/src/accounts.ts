import { z } from 'zod';
import { jellyfinUserId } from './common.js';

/**
 * Not in the original S6, but required by it: S7.5 asks the plugin config page
 * to render "local Jellyfin users with their link state", and S6.2 requires an
 * account row to exist so unlinked users show up in the owner's linking UI.
 * The plugin therefore reports its local user list, and gets the current link
 * states back to render.
 *
 * This is a report, not an assertion of identity -- link_state is only ever
 * advanced by the member accepting an invite (S8).
 */
export const linkState = z.enum(['unlinked', 'pending', 'linked', 'rejected']);
export type LinkState = z.infer<typeof linkState>;

export const reportedAccount = z.object({
  jellyfin_user_id: jellyfinUserId,
  jellyfin_username: z.string().max(128).nullish(),
});

export const accountsReportRequest = z.object({
  accounts: z.array(reportedAccount).max(500),
});
export type AccountsReportRequest = z.infer<typeof accountsReportRequest>;

export const accountsReportResponse = z.object({
  accounts: z.array(
    z.object({
      jellyfin_user_id: jellyfinUserId,
      jellyfin_username: z.string().nullable(),
      link_state: linkState,
      /** Display name of the linked tracker user, once linked. */
      linked_display_name: z.string().nullable(),
    }),
  ),
});
export type AccountsReportResponse = z.infer<typeof accountsReportResponse>;

/** Owner asks the tracker for an invite URL to hand to the member over Discord. */
export const accountInviteRequest = z.object({
  jellyfin_user_id: jellyfinUserId,
});

export const accountInviteResponse = z.object({
  invite_url: z.url(),
  expires_at: z.iso.datetime({ offset: true }),
});
export type AccountInviteResponse = z.infer<typeof accountInviteResponse>;
