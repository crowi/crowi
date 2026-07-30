/**
 * Shared data factories for web unit tests.
 *
 * Keep factories here when the same fixture shape appears in 3 or more
 * test files. Two occurrences (makePage ×2, makeMeta ×2) follow the DAMP
 * principle and stay local — centralise on the 3rd copy.
 */

import type { Attachment } from '@crowi/api-contract';

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
