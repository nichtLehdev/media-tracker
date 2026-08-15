import { newId, schema, sql, type Database } from '@media-tracker/db';
import type { IngestItem, LibraryItem } from '@media-tracker/contracts';

/** The fields §9 needs, common to an ingest item and a library item. */
export type ResolvableItem = IngestItem | LibraryItem;

/**
 * S9 step 5: never guess. Record the item and let the owner resolve it on
 * /admin/unmatched; resolving one backfills whatever was pending on it.
 *
 * `raw` deliberately carries no path or filename (S6.3.3) -- those leak
 * directory structure and release-group naming for things a member may not
 * want published.
 */
export async function recordUnmatched(
  db: Database,
  serverId: string,
  item: ResolvableItem,
  now: Date,
): Promise<void> {
  await db
    .insert(schema.unmatchedItems)
    .values({
      id: newId(),
      serverId,
      jellyfinItemId: item.jellyfin_item_id,
      raw: {
        item_type: item.item_type,
        name: item.name,
        production_year: item.production_year ?? null,
        series_name: item.series_name ?? null,
        season: item.season ?? null,
        episode: item.episode ?? null,
        provider_ids: item.provider_ids,
        series_provider_ids: item.series_provider_ids,
      },
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.unmatchedItems.serverId,
        schema.unmatchedItems.jellyfinItemId,
      ],
      set: { lastSeenAt: now, raw: sql.raw('excluded.raw') },
    });
}
