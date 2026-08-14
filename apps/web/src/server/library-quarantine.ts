import { createHash } from 'node:crypto';
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  ne,
  schema,
  newId,
  type Database,
} from '@media-tracker/db';

/**
 * S7.6, the mass-removal safety valve.
 *
 * Jellyfin fires ItemRemoved when a scan finds files missing, and "missing"
 * includes "the storage backend is temporarily unavailable". A member whose
 * library sits on a network mount will, sooner or later, have that mount drop
 * mid-scan; Jellyfin then correctly concludes several thousand files are gone
 * and emits removals for all of them. Applying that batch wipes the member's
 * library and turns their availability red across every screening, and it is
 * only repaired by the next successful snapshot -- if the mount is back.
 *
 * The guard is applied identically to deltas and to snapshot reconciliation.
 * Additions are never routed through here: a false-positive addition is
 * harmless.
 */

/** Absolute ceiling on a single removal batch. */
export const MAX_REMOVALS = 200;
/** Proportional ceiling, applied to the member's entries on that server. */
export const MAX_REMOVAL_FRACTION = 0.1;
/**
 * Floor, so the proportional rule does not flag routine tidying. Not in §7.6;
 * see docs/implementation-notes.md. A 30-entry library would otherwise
 * quarantine at four removals, and an owner who sees the notice weekly stops
 * reading it -- which is the one thing this guard cannot survive.
 */
export const MIN_REMOVAL_ALLOWANCE = 5;
/** Consecutive snapshots proposing the same set before it auto-applies. */
export const AUTO_RELEASE_OCCURRENCES = 3;
/** Minimum spacing between those snapshots. A flapping mount is not this regular. */
export const AUTO_RELEASE_MIN_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * §7.6's "more than 10% of entries, or more than 200 entries, whichever is
 * lower", lifted to MIN_REMOVAL_ALLOWANCE at the bottom end.
 */
export function removalThreshold(libraryCount: number): number {
  return Math.max(
    MIN_REMOVAL_ALLOWANCE,
    Math.min(Math.floor(libraryCount * MAX_REMOVAL_FRACTION), MAX_REMOVALS),
  );
}

/** Exclusive: removing exactly the threshold is allowed. */
export function exceedsRemovalThreshold(
  libraryCount: number,
  removalCount: number,
): boolean {
  if (removalCount === 0) return false;
  return removalCount > removalThreshold(libraryCount);
}

/**
 * Hash of the sorted entry ids. This is what lets `occurrences` count repeats
 * of the *same* removal set rather than three unrelated flaps in a row.
 */
export function fingerprintEntryIds(entryIds: readonly string[]): string {
  return createHash('sha256')
    .update([...entryIds].sort().join('\n'))
    .digest('base64url');
}

export type RemovalSource = 'delta' | 'snapshot';

export interface RemovalProposal {
  serverId: string;
  userId: string;
  /** `library_entries.id` values the sender proposes to delete. */
  entryIds: readonly string[];
  source: RemovalSource;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

export interface RemovalOutcome {
  /** True when the batch was held rather than applied. */
  quarantined: boolean;
  /** Entries actually deleted. */
  removed: number;
  quarantineId: string | null;
  /** Consecutive snapshots that have proposed this set, when quarantined. */
  occurrences: number | null;
  /** True when this call released a previously quarantined set. */
  autoApplied: boolean;
}

const noop: RemovalOutcome = {
  quarantined: false,
  removed: 0,
  quarantineId: null,
  occurrences: null,
  autoApplied: false,
};

/**
 * Applies a proposed removal set, or quarantines it. The caller has already
 * resolved Jellyfin item ids to `library_entries` rows; ids that no longer
 * exist are dropped here rather than counted, so a re-sent delta cannot inflate
 * its way over the threshold.
 */
export async function applyRemovals(
  database: Database,
  proposal: RemovalProposal,
): Promise<RemovalOutcome> {
  const { serverId, userId, entryIds, source } = proposal;
  const now = proposal.now ?? new Date();

  return await database.transaction(async (tx) => {
    const entries = schema.libraryEntries;
    const quarantine = schema.librarySyncQuarantine;
    const owned = and(eq(entries.userId, userId), eq(entries.serverId, serverId));

    const targets =
      entryIds.length === 0
        ? []
        : (
            await tx
              .select({ id: entries.id })
              .from(entries)
              .where(and(owned, inArray(entries.id, [...entryIds])))
          ).map((row) => row.id);

    const fingerprint = fingerprintEntryIds(targets);

    // A snapshot is the authority. Anything it no longer proposes has come
    // back, so open proposals for other sets are stale and their streak is
    // broken -- otherwise a flapping mount could bank three sightings of a set
    // it stopped reporting and auto-apply it later.
    if (source === 'snapshot') {
      await tx
        .update(quarantine)
        .set({ resolvedAt: now, resolution: 'dismissed' })
        .where(
          and(
            eq(quarantine.serverId, serverId),
            eq(quarantine.userId, userId),
            isNull(quarantine.resolvedAt),
            ne(quarantine.fingerprint, fingerprint),
          ),
        );
    }

    if (targets.length === 0) return noop;

    const counted = await tx
      .select({ value: count() })
      .from(entries)
      .where(owned);
    const libraryCount = counted[0]?.value ?? 0;

    if (!exceedsRemovalThreshold(libraryCount, targets.length)) {
      await tx.delete(entries).where(inArray(entries.id, targets));
      return { ...noop, removed: targets.length };
    }

    const [open] = await tx
      .select()
      .from(quarantine)
      .where(
        and(
          eq(quarantine.serverId, serverId),
          eq(quarantine.userId, userId),
          eq(quarantine.fingerprint, fingerprint),
          isNull(quarantine.resolvedAt),
        ),
      )
      .limit(1);

    if (!open) {
      const id = newId();
      await tx.insert(quarantine).values({
        id,
        serverId,
        userId,
        entryIds: targets,
        entryCount: targets.length,
        libraryCount,
        fingerprint,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      return { ...noop, quarantined: true, quarantineId: id, occurrences: 1 };
    }

    // Only full snapshots advance the streak, and only when spaced. `lastSeenAt`
    // deliberately tracks the last *counted* sighting rather than every
    // proposal: deltas arrive every couple of minutes and would otherwise keep
    // resetting the clock, so the six-hour gap could never accumulate.
    const spaced =
      now.getTime() - open.lastSeenAt.getTime() >= AUTO_RELEASE_MIN_GAP_MS;
    if (source !== 'snapshot' || !spaced) {
      return {
        ...noop,
        quarantined: true,
        quarantineId: open.id,
        occurrences: open.occurrences,
      };
    }

    const occurrences = open.occurrences + 1;

    if (occurrences >= AUTO_RELEASE_OCCURRENCES) {
      await tx.delete(entries).where(inArray(entries.id, targets));
      await tx
        .update(quarantine)
        .set({
          occurrences,
          lastSeenAt: now,
          resolvedAt: now,
          resolution: 'auto_applied',
        })
        .where(eq(quarantine.id, open.id));
      return {
        quarantined: false,
        removed: targets.length,
        quarantineId: open.id,
        occurrences,
        autoApplied: true,
      };
    }

    await tx
      .update(quarantine)
      .set({ occurrences, lastSeenAt: now })
      .where(eq(quarantine.id, open.id));

    return { ...noop, quarantined: true, quarantineId: open.id, occurrences };
  });
}
