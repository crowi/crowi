/**
 * Which Revision an artifact request targets. Shared by the mint route and
 * the stream/download route so the two cannot drift: they answer the same
 * question (an explicit revision id, else the Page's current one) and must
 * reject the same way, since one hands out a URL for exactly what the other
 * will serve.
 */

import { Types } from 'mongoose';

import type { RevisionDocument, RevisionModel } from 'src/models/revision';
import { isValidObjectId } from 'src/util/ts-rest-helpers';

export type ResolveTargetRevisionResult =
  | { ok: true; revision: RevisionDocument }
  | { ok: false; reason: 'invalid-id' }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'pointerless' };

/** Given an optional explicit revision id and the Page's populated current revision, resolves which Revision the request targets. */
export async function resolveTargetRevision(
  Revision: RevisionModel,
  explicitRevisionId: string | undefined,
  currentRevision: RevisionDocument | undefined,
  normalizedPageId: string,
): Promise<ResolveTargetRevisionResult> {
  if (explicitRevisionId !== undefined) {
    if (!isValidObjectId(explicitRevisionId)) return { ok: false, reason: 'invalid-id' };
    const revision = (await Revision.findRevision(new Types.ObjectId(explicitRevisionId))) as RevisionDocument | null;
    // Don't distinguish "missing" from "belongs to another page" — both
    // report as 'not-found' — to avoid leaking information about other
    // pages' revisions.
    if (!revision || revision.page == null || revision.page.toString() !== normalizedPageId) return { ok: false, reason: 'not-found' };
    return { ok: true, revision };
  }
  if (!currentRevision) return { ok: false, reason: 'pointerless' };
  return { ok: true, revision: currentRevision };
}
