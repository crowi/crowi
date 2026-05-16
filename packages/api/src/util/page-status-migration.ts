import Debug from 'debug';
import type Crowi from 'src/crowi';
import { STATUS_PUBLISHED } from 'src/models/page';

const debug = Debug('crowi:util:page-status-migration');

/**
 * RFC-0004 backfill: stamp `status: 'published'` onto every legacy
 * `Page` row that has no `status` (the field is missing, or stored as
 * `null`).
 *
 * Why this is needed: RFC-0004 introduces a first-class `draft` state
 * and the listing / search / backlink queries now branch on
 * `Page.status`. Pages created before the `status` field existed read
 * back as `null`; `Page.isPublished()` already treats `null` as
 * published for back-compat, but the query-level `$or` filters and the
 * collab draft gate are clearer — and future-proof against a stricter
 * `required: true` — when every row carries an explicit value.
 *
 * Idempotent: the filter only matches rows that are still unset, so a
 * second run touches nothing. Pages already `published` / `draft` /
 * `deleted` / `deprecated` / `wip` are left exactly as they are — in
 * particular this never rewrites a `draft` back to `published`, which
 * would violate the one-way transition rule.
 *
 * Returns the number of rows updated, so the boot log can report it.
 */
export async function runPageStatusMigration(crowi: Crowi): Promise<number> {
  const Page = crowi.model('Page');

  // `status: null` matches both an explicit null and a missing field
  // in MongoDB query semantics, so a single condition covers every
  // legacy shape.
  const result = await Page.updateMany({ status: null }, { $set: { status: STATUS_PUBLISHED } });

  // Mongoose's UpdateResult exposes `modifiedCount`; fall back to 0 for
  // any driver shape that omits it.
  const modified = (result as { modifiedCount?: number }).modifiedCount ?? 0;
  if (modified > 0) {
    console.log(`[crowi] Backfilled status='published' on ${modified} legacy page row(s).`);
  } else {
    debug('no legacy pages without status — nothing to migrate');
  }
  return modified;
}
