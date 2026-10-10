import type { PageWithRevision } from '@crowi/api-contract';
import { describe, expect, it } from 'vitest';
import { canEditPageBodyInWeb } from './page-editability';

const withRevision = (contentType: unknown) => ({ revision: { _id: 'r1', contentType } }) as unknown as Pick<PageWithRevision, 'revision'>;

describe('canEditPageBodyInWeb (R-3)', () => {
  it('allows a Markdown revision', () => {
    expect(canEditPageBodyInWeb(withRevision('markdown'))).toBe(true);
  });

  it('refuses an artifact revision', () => {
    expect(canEditPageBodyInWeb(withRevision('artifact'))).toBe(false);
  });

  it('treats a revision stored without contentType as legacy Markdown', () => {
    expect(canEditPageBodyInWeb(withRevision(undefined))).toBe(true);
  });

  it('never assumes Markdown for a page or revision that has not been fetched', () => {
    expect(canEditPageBodyInWeb(null)).toBe(false);
    expect(canEditPageBodyInWeb(undefined)).toBe(false);
    expect(canEditPageBodyInWeb({ revision: undefined } as unknown as Pick<PageWithRevision, 'revision'>)).toBe(false);
    expect(canEditPageBodyInWeb({ revision: null } as unknown as Pick<PageWithRevision, 'revision'>)).toBe(false);
    // A bare revision id (a pointer, not a fetched revision) carries no kind.
    expect(canEditPageBodyInWeb({ revision: 'rev-1' } as unknown as Pick<PageWithRevision, 'revision'>)).toBe(false);
  });
});
