/**
 * Shared data factories for web unit tests.
 *
 * Keep factories here when the same fixture shape appears in 3 or more
 * test files. Two occurrences (makePage ×2, makeMeta ×2) follow the DAMP
 * principle and stay local — centralise on the 3rd copy.
 */

import type { Attachment, Page } from '@crowi/api-contract';

/**
 * Build a minimal `Page` fixture (a list row: no revision, no grant).
 * Centralised here because the same definition appeared in:
 *   - page-list-item.test.tsx
 *   - page-display-user.test.ts
 *   - user-subpages.test.tsx
 * Give rows that share a list distinct `_id`s — list components key on it.
 */
export function makePage(overrides: Partial<Page> = {}): Page {
  return {
    _id: 'page-1',
    path: '/docs/example',
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    isLiked: false,
    ...overrides,
  } as Page;
}

/**
 * Build a minimal `Attachment` fixture.  Centralised here because the same
 * definition appeared identically in:
 *   - attachment-detail-modal.test.tsx
 *   - attachment-list.test.tsx
 *   - attachment-usage-view.test.tsx
 */
export function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    _id: 'att-1',
    page: 'page-1',
    creator: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    filePath: 'attachment/page-1/att-1.png',
    fileName: 'att-1.png',
    originalName: 'diagram.png',
    fileFormat: 'image/png',
    fileSize: 2048,
    createdAt: '2026-05-01T09:30:00.000Z',
    url: '/api/attachments/att-1',
    originalUrl: '/api/attachments/att-1/original',
    inUse: true,
    ...overrides,
  };
}
