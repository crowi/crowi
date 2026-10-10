import { type PageContentType, PageContentTypeSchema } from '@crowi/api-contract';
import { Types } from 'mongoose';
import { ArtifactInternalError } from 'src/artifact/ingest';
import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';

/**
 * Proof that a handler's artifact pre-write (policy snapshot, delivery gate,
 * ingest) succeeded for exactly this normalized body. The shared save
 * boundary only checks the proof is present and matches the body being
 * stored; it never re-runs ingest.
 */
export type ArtifactPreWriteAccepted = Readonly<{ ok: true; body: string }>;

/**
 * A Page whose body kind is already settled is asked to accept a Revision of a
 * different kind. Rejected before the new Revision becomes durable so a Page
 * can never flip between Markdown and artifact in place. Closed message: no
 * body / path / kind detail reaches an operator log or HTTP response.
 */
export class PageContentTypeConflictError extends Error {
  readonly pageId: string;

  constructor(pageId: Types.ObjectId, options?: { cause?: unknown }) {
    super(`page content type conflict for page ${pageId}`);
    this.name = 'PageContentTypeConflictError';
    this.pageId = String(pageId);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface CurrentPageBodyKind {
  /** `null` when the Page has no revision pointer yet (kind not settled). */
  revisionId: string | null;
  contentType: PageContentType;
}

type PageWithPointer = Pick<PageDocument, '_id' | 'revision'> & { populated?: (path: string) => unknown };

/**
 * The raw (pre-populate) revision pointer of a Page. A populated Mongoose
 * document remembers it in `populated('revision')`; a populate whose target is
 * missing leaves `page.revision === null` while the pointer is still set, which
 * is the dangling-pointer case callers must not mistake for "no pointer".
 */
export function getRawRevisionPointer(page: PageWithPointer): Types.ObjectId | null {
  const populated = typeof page.populated === 'function' ? page.populated('revision') : undefined;
  if (populated != null) return populated as Types.ObjectId;
  const revision: unknown = page.revision;
  if (revision == null) return null;
  if (revision instanceof Types.ObjectId) return revision;
  if (typeof revision === 'object' && '_id' in revision) return (revision as { _id: Types.ObjectId })._id;
  return revision as Types.ObjectId;
}

interface RevisionKindRow {
  _id: Types.ObjectId;
  contentType?: unknown;
  isSelected?: (path: string) => boolean;
}

function normalizeStoredKind(value: unknown): PageContentType {
  if (value === undefined) return 'markdown';
  const parsed = PageContentTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactInternalError('resolveCurrentPageBodyKind: unrecognized stored contentType');
  }
  return parsed.data;
}

/**
 * Resolves the kind of the Page's CURRENT Revision. `revisionPointer` is the
 * raw pointer (see `getRawRevisionPointer`); `null` means the pointer was
 * never set. A non-null pointer whose Revision is missing or unreadable is
 * internal-state corruption, never a fallback to Markdown. A real Revision
 * with no `contentType` field is legacy Markdown.
 */
export async function resolveCurrentPageBodyKind(crowi: Crowi, page: PageWithPointer, revisionPointer: Types.ObjectId | null): Promise<CurrentPageBodyKind> {
  if (revisionPointer == null) return { revisionId: null, contentType: 'markdown' };
  const pointerId = String(revisionPointer);

  const current: unknown = page.revision;
  let row: RevisionKindRow | null = null;
  if (typeof current === 'object' && current !== null && !(current instanceof Types.ObjectId)) {
    const candidate = current as RevisionKindRow;
    // A populate with a projection that dropped `contentType` must not read as legacy Markdown.
    if (typeof candidate.isSelected !== 'function' || candidate.isSelected('contentType')) {
      row = candidate;
    }
  }
  if (row === null) {
    row = (await crowi.model('Revision').findById(pointerId).select('_id contentType').lean().exec()) as RevisionKindRow | null;
  }
  if (row === null || String(row._id) !== pointerId) {
    throw new ArtifactInternalError('resolveCurrentPageBodyKind: the revision pointer does not resolve to its Revision');
  }
  return { revisionId: pointerId, contentType: normalizeStoredKind(row.contentType) };
}
