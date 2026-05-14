import * as Y from 'yjs';
import mongoose from 'mongoose';
import type { CollabModels } from '../models';
import { CONTENT_FIELD } from '../yjs-doc';

/**
 * Test fixtures shared between the Phase 3 smoke test and the Phase 4
 * compaction test. The helpers close over `CollabModels` to keep the
 * call sites flat — once Phase 5+ adds more test files against the
 * same models, they can pull from here without reproducing the
 * Page/Revision boilerplate again.
 */

/**
 * Encode `text` as a standalone Y.Doc update — used to seed synthetic
 * `PageYjsUpdate.payload` bytes that `Y.applyUpdate` will accept.
 */
export function encodeYjsDelta(text: string): Buffer {
  const doc = new Y.Doc();
  doc.getText(CONTENT_FIELD).insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

export interface CollabFixtures {
  /** Create a fresh, granted page with a unique path. */
  seedPage(overrides?: Record<string, unknown>): Promise<{ pageId: string }>;
  /** Create a revision body and link it via `Page.revision`. Returns the revision id. */
  seedRevision(pageId: string, body: string): Promise<string>;
  /** Count current `PageYjsUpdate` rows for a page. */
  countPending(pageId: string): Promise<number>;
}

export function makeFixtures(models: CollabModels): CollabFixtures {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = models.Page as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Revision = models.Revision as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = models.PageYjsUpdate as any;

  return {
    async seedPage(overrides = {}) {
      const userId = new mongoose.Types.ObjectId();
      const page = await Page.create({
        path: `/__collab-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        creator: userId,
        grant: 1,
        status: 'published',
        ...overrides,
      });
      return { pageId: page._id.toString() };
    },
    async seedRevision(pageId, body) {
      const page = await Page.findById(pageId).exec();
      if (!page) throw new Error(`seedRevision: page ${pageId} not found`);
      const revision = await Revision.create({
        path: page.path,
        body,
        author: page.creator,
        format: 'markdown',
      });
      page.revision = revision._id;
      await page.save();
      return revision._id.toString();
    },
    async countPending(pageId) {
      return PageYjsUpdate.countDocuments({ pageId }).exec();
    },
  };
}
