import { crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';

/**
 * RFC-0003 §"Server-side direct Markdown edits" — an external (REST / API)
 * edit via `Page.updatePage` must invalidate the collaborative editor's
 * persisted Y.Doc snapshot so a later editor session rebuilds from the new
 * revision instead of restoring the pre-edit doc (which would show stale
 * content and, on its next autosave, silently revert the external edit).
 */
const seedUser = (suffix: string) =>
  new Promise<UserDocument>((resolve, reject) => {
    const User = crowi.model('User');
    User.createUserByEmailAndPassword(
      `Ext ${suffix}`,
      `ext-${suffix}`,
      `ext-${suffix}@example.com`,
      'password123',
      'en',
      async (err: Error | null, user: UserDocument) => {
        if (err) return reject(err);
        user.status = User.STATUS_ACTIVE;
        await user.save();
        resolve(user);
      },
    );
  });

describe('Page.updatePage — external edit invalidates collab state', () => {
  it('clears yjsState and re-points currentRevision to the new revision', async () => {
    const Page = crowi.model('Page');
    const user = await seedUser('a');

    await Page.createPage('/ext-edit-a', '# original\n\noriginal body', user, {});
    let page = await Page.findOne({ path: '/ext-edit-a' });
    if (!page) throw new Error('page not created');

    const originalRevisionId = page.revision?.toString();

    // Simulate a prior collaborative session: a persisted Y.Doc checkpoint
    // and a collab pointer to the current revision (this is the state the
    // collab save flow leaves behind).
    page.yjsState = Buffer.from([1, 2, 3, 4]);
    page.currentRevision = page.revision as typeof page.currentRevision;
    page.yjsCheckpointAt = new Date();
    await page.save();

    // External (REST / API) edit.
    await Page.updatePage(page, '# changed\n\nNEW EXTERNAL BODY', user, {});

    page = await Page.findOne({ path: '/ext-edit-a' });
    if (!page) throw new Error('page missing after update');

    const newRevisionId = page.revision?.toString();
    expect(newRevisionId).not.toBe(originalRevisionId);

    // The stale Y.Doc snapshot is dropped so the next onLoadDocument rebuilds.
    expect(page.yjsState ?? null).toBeNull();
    expect(page.yjsCheckpointAt ?? null).toBeNull();

    // currentRevision tracks the new revision so the rebuild
    // (`currentRevision ?? revision`) seeds from the new body, not the old one.
    expect(page.currentRevision?.toString()).toBe(newRevisionId);

    const Revision = crowi.model('Revision');
    const rev = await Revision.findById(page.revision).select('body').lean().exec();
    expect(rev?.body).toContain('NEW EXTERNAL BODY');
  });
});
