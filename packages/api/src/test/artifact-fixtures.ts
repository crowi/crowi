/**
 * Minimal HTML artifact fixtures shared by `artifact/ingest.test.ts` and by
 * later leaves (`csp.test.ts`, `page.test.ts`). Lives outside any
 * `*.test.ts` file because two test files importing from each other would
 * register each other's `describe` blocks twice.
 */

import { createHash } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';

/** The CSP hash-source token (without quotes) an inline block with this exact text needs. */
export function sha256Token(text: string): string {
  return `sha256-${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('base64')}`;
}

/**
 * Builds a document that passes every rule in `ARTIFACT_INGEST_RULES`:
 * one inline `<script>`, one inline `<style>`, a `charset` meta, and a
 * single body element. Callers override the script/style/body source to
 * exercise specific behaviour while keeping everything else valid.
 */
export function validArtifactHtml(options?: Readonly<{ script?: string; style?: string; body?: string }>): string {
  const script = options?.script ?? "console.log('crowi-artifact-fixture');";
  const style = options?.style ?? 'body { color: rebeccapurple; }';
  const body = options?.body ?? '<p>hello from the artifact fixture</p>';
  return (
    '<!doctype html>\n' +
    '<html>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    `<style>${style}</style>\n` +
    `<script>${script}</script>\n` +
    '</head>\n' +
    '<body>\n' +
    `${body}\n` +
    '</body>\n' +
    '</html>\n'
  );
}

export const VALID_ARTIFACT_HTML = validArtifactHtml();

/**
 * Test-only: persists an ALREADY-STORED artifact Page + current Revision
 * straight through the native collections, bypassing `Page.createPage` /
 * `Page.pushRevision`. The save boundary refuses an artifact body that did not
 * come with a handler pre-write success value, so tests that need legacy,
 * invalid, or inconsistent stored state (a body today's ingest would reject, a
 * mismatched hint, ...) must seed it this way; tests of the boundary itself go
 * through the real models / HTTP instead.
 *
 * Requires a booted Crowi (the Page / Revision models registered).
 */
export async function seedStoredArtifactPage(input: {
  path: string;
  body: string;
  userId: Types.ObjectId | string;
  status?: string;
  /** The Page's list-view hint; defaults to `'artifact'`. `null` leaves the field unset. */
  pageContentType?: 'markdown' | 'artifact' | null;
}): Promise<{ pageId: string; revisionId: string }> {
  const Page = mongoose.model('Page');
  const Revision = mongoose.model('Revision');
  const userId = new mongoose.Types.ObjectId(String(input.userId));
  const now = new Date();
  const hint = input.pageContentType === undefined ? 'artifact' : input.pageContentType;

  const page = new Page({
    path: input.path,
    creator: userId,
    lastUpdateUser: userId,
    grant: 1,
    grantedUsers: [userId],
    status: input.status ?? 'published',
    createdAt: now,
    updatedAt: now,
  });
  const revision = new Revision({
    path: input.path,
    page: page._id,
    body: input.body,
    format: 'markdown',
    author: userId,
    createdAt: now,
    contentType: 'artifact',
  });
  const pageDoc: Record<string, unknown> = { ...page.toObject(), revision: revision._id };
  if (hint !== null) pageDoc.contentType = hint;
  await Revision.collection.insertOne(revision.toObject());
  await Page.collection.insertOne(pageDoc);
  return { pageId: String(page._id), revisionId: String(revision._id) };
}
