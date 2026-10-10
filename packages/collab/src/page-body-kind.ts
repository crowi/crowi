import { resolvePageEpoch } from './doc-epoch';
import type { CollabModels } from './models';

/**
 * Whether a Page's body may enter the Markdown collab pipeline (Y.Text is
 * Markdown source). The decision is made from the Revisions the Page points
 * at, not from the Page's denormalized `contentType` hint alone:
 *
 *   - `missing`       — no such Page.
 *   - `content-type`  — the Page hint, or either pointed-at Revision, is an artifact.
 *   - `invalid-state` — a non-null pointer whose Revision does not exist, or a
 *                       stored kind that is neither `markdown` nor `artifact`
 *                       (fail closed; an administrator repairs it).
 *
 * A Page with no pointer is Markdown; a Revision without a `contentType`
 * field is legacy Markdown. A soft-deleted Page is deliberately NOT a
 * rejection here: each caller keeps its own status / epoch handling for it.
 */
export type CollabBodyEligibility =
  | {
      ok: true;
      /** `Page.revision` as read, `null` when unset. */
      revisionId: string | null;
      /** `Page.currentRevision` as read, `null` when unset. */
      currentRevisionId: string | null;
      /** `Page.collabLifecycleVersion`, `0` when the field is missing. */
      epoch: number;
    }
  | { ok: false; reason: 'missing' | 'content-type' | 'invalid-state' };

interface PageEligibilityRow {
  revision?: { toString(): string } | null;
  currentRevision?: { toString(): string } | null;
  contentType?: unknown;
  collabLifecycleVersion?: number;
}

interface RevisionEligibilityRow {
  _id: { toString(): string };
  contentType?: unknown;
}

/**
 * One Page read plus at most one Revision read (`$in` over the 0-2 distinct
 * pointers), both metadata-only: no body or Yjs bytes are read.
 */
export async function readCollabBodyEligibility(models: Pick<CollabModels, 'Page' | 'Revision'>, pageId: string): Promise<CollabBodyEligibility> {
  const page = (await models.Page.findById(pageId)
    .select('_id revision currentRevision contentType status collabLifecycleVersion')
    .lean()
    .exec()) as PageEligibilityRow | null;
  if (!page) return { ok: false, reason: 'missing' };

  const revisionId = page.revision != null ? page.revision.toString() : null;
  const currentRevisionId = page.currentRevision != null ? page.currentRevision.toString() : null;

  if (page.contentType === 'artifact') return { ok: false, reason: 'content-type' };
  if (page.contentType != null && page.contentType !== 'markdown') return { ok: false, reason: 'invalid-state' };

  const pointerIds = [...new Set([revisionId, currentRevisionId].filter((id): id is string => id !== null))];
  if (pointerIds.length > 0) {
    const rows = (await models.Revision.find({ _id: { $in: pointerIds } })
      .select('_id contentType')
      .lean()
      .exec()) as RevisionEligibilityRow[];
    const byId = new Map(rows.map((row) => [row._id.toString(), row]));
    let invalid = false;
    for (const id of pointerIds) {
      const row = byId.get(id);
      if (!row) {
        invalid = true;
        continue;
      }
      if (row.contentType === 'artifact') return { ok: false, reason: 'content-type' };
      if (row.contentType !== undefined && row.contentType !== 'markdown') invalid = true;
    }
    if (invalid) return { ok: false, reason: 'invalid-state' };
  }

  return { ok: true, revisionId, currentRevisionId, epoch: resolvePageEpoch(page.collabLifecycleVersion) };
}
