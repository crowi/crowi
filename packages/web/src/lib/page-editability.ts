import type { PageWithRevision } from '@crowi/api-contract';

/**
 * Whether the Web's Markdown editor may be offered for this page's body.
 * Only a fetched current revision can answer: a page or revision that has not
 * been fetched yet is NOT assumed to be Markdown (the button simply is not
 * shown until the kind is known), and a revision stored without a
 * `contentType` is legacy Markdown. This is a display decision only — the
 * server independently refuses a Markdown write to an artifact page.
 */
export function canEditPageBodyInWeb(page: Pick<PageWithRevision, 'revision'> | null | undefined): boolean {
  const revision = page?.revision;
  if (!revision || typeof revision !== 'object') return false;
  return (revision.contentType ?? 'markdown') === 'markdown';
}
