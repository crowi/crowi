import { createPageViaApi, deletePageViaApi, getPageBody, renamePageViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';
import { EditorPage } from '../src/pages/editor-page';
import { readSharedState } from '../src/shared-state';

test('collab propagates edits between two authenticated users', async ({ userAPage, userBPage }) => {
  const { pageId } = await readSharedState();
  const editorA = new EditorPage(userAPage);
  const editorB = new EditorPage(userBPage);

  await Promise.all([editorA.openSharedPage(pageId), editorB.openSharedPage(pageId)]);

  const marker = `\nE2E collab propagation ${Date.now()}\n`;
  await editorA.appendText(marker);
  await editorB.waitForText(marker.trim());
});

/**
 * RFC-0017 Phase 1 — rename/delete must invalidate a live collab editor:
 * the client sees a force-reload prompt and never silently merges the
 * lifecycle transition into its still-open (now stale) session, AND a save
 * attempted from that stale session is rejected server-side (the
 * `executeSave` atomic CAS folds `collabLifecycleVersion`) rather than
 * silently landing as a new revision. These tests seed their OWN dedicated
 * page (not the collab.spec.ts shared page above) since a rename/delete
 * permanently mutates it.
 *
 * The reload prompt is `CollabForceReloadDialog`
 * (`packages/web/src/components/editor/collab-force-reload-dialog.tsx`), a
 * Radix `AlertDialog` (`role="alertdialog"`). userB's context is used purely
 * as an authenticated actor for the API call — the mutation is not driven
 * through userB's UI, matching "a different window/API renames or deletes
 * the page" from the task's e2eTargets summary.
 *
 * The stale-save attempt (`editorA.clickSave()`) is deliberately fired
 * right after the rename/delete API call resolves, well within the
 * invalidator's `DEFAULT_INVALIDATE_GRACE_MS` (1500ms) drain window before
 * the still-open connection is force-closed — see
 * `packages/collab/src/invalidation.ts`. AC-41's outcome is verified via
 * `getPageBody`, not by inspecting the client's error path: the persisted
 * revision body is asserted to be UNCHANGED from before the mutation, so a
 * regression that let the stale save through would fail this test even if
 * the reload prompt still happened to render for an unrelated reason.
 */
test.describe('RFC-0017 Phase 1 — rename/delete invalidates a live collab editor', () => {
  test('rename opens a force-reload prompt and rejects a stale save from the still-open editor (no silent merge, no persistence)', async ({
    userAPage,
    userBPage,
  }) => {
    const path = `/e2e/collab/rfc0017-rename-${Date.now()}`;
    const originalBody = '# RFC-0017 rename target\n\noriginal body';
    const pageId = await createPageViaApi(userAPage.context(), { path, body: originalBody });

    const editorA = new EditorPage(userAPage);
    await editorA.openSharedPage(pageId);

    const marker = `\nlive edit before rename ${Date.now()}\n`;
    await editorA.appendText(marker);

    await renamePageViaApi(userBPage.context(), { pageId, newPath: `${path}-renamed` });
    // AC-1/AC-41 — rename never touches `currentRevision`, so only the
    // epoch predicate can reject this save; attempt it while the
    // connection is still alive (pre-force-close).
    await editorA.clickSave();

    // The reload prompt must appear — not a silent content swap.
    await expect(userAPage.getByRole('alertdialog')).toBeVisible({ timeout: 15_000 });
    // The stale editor content is untouched (no silent merge of the
    // post-rename state over the live session) — the marker this session
    // typed before the rename is still exactly what's on screen.
    await expect(userAPage.locator('.cm-content').first()).toContainText(marker.trim());

    // AC-41 — the stale save never landed: the persisted revision body is
    // still exactly the pre-rename content, it never picked up the marker
    // "saved" after the rename's epoch advance.
    await expect(async () => {
      expect(await getPageBody(userBPage.context(), pageId)).toBe(originalBody);
    }).toPass({ timeout: 15_000 });
  });

  test('delete opens a force-reload prompt and rejects a stale save from the still-open editor (no silent merge, no persistence)', async ({
    userAPage,
    userBPage,
  }) => {
    const path = `/e2e/collab/rfc0017-delete-${Date.now()}`;
    const originalBody = '# RFC-0017 delete target\n\noriginal body';
    const pageId = await createPageViaApi(userAPage.context(), { path, body: originalBody });

    const editorA = new EditorPage(userAPage);
    await editorA.openSharedPage(pageId);

    const marker = `\nlive edit before delete ${Date.now()}\n`;
    await editorA.appendText(marker);

    await deletePageViaApi(userBPage.context(), { pageId });
    // AC-3/AC-41 — a soft-deleted page's stale save is rejected by BOTH the
    // advanced epoch and the complementary `status: { $ne: STATUS_DELETED }`
    // predicate.
    await editorA.clickSave();

    await expect(userAPage.getByRole('alertdialog')).toBeVisible({ timeout: 15_000 });
    await expect(userAPage.locator('.cm-content').first()).toContainText(marker.trim());

    // AC-41 — same no-persistence assertion as the rename case above.
    await expect(async () => {
      expect(await getPageBody(userBPage.context(), pageId)).toBe(originalBody);
    }).toPass({ timeout: 15_000 });
  });

  /**
   * AC-32/AC-39/AC-41 — a SUBTREE rename must invalidate every open editor
   * on a MOVED DESCENDANT, not just the root page being renamed. Each moved
   * descendant advances its own `collabLifecycleVersion` and broadcasts its
   * own `page-renamed` reload prompt via its own per-page `Page.rename`
   * call inside `renameTree` (`packages/api/src/models/page.ts`'s D8) — this
   * is model-tested (`page-lifecycle-epoch.test.ts`) but, before this test,
   * had no browser-level proof that a CHILD editor (which never appears in
   * the rename API call — only the parent's `page_id` does) actually gets
   * the reload prompt and has its stale save rejected.
   */
  test('subtree rename invalidates a live editor open on a moved descendant (child), not just the renamed parent', async ({ userAPage, userBPage }) => {
    const parentPath = `/e2e/collab/rfc0017-subtree-parent-${Date.now()}`;
    const childPath = `${parentPath}/child`;
    const originalParentBody = '# RFC-0017 subtree parent\n\noriginal parent body';
    const originalChildBody = '# RFC-0017 subtree child\n\noriginal child body';

    const parentPageId = await createPageViaApi(userAPage.context(), { path: parentPath, body: originalParentBody });
    const childPageId = await createPageViaApi(userAPage.context(), { path: childPath, body: originalChildBody });

    // Open the editor on the CHILD only — the rename call below targets the
    // PARENT's page_id, so the child is invalidated purely as a moved
    // descendant, never directly addressed by the mutation.
    const editorChild = new EditorPage(userAPage);
    await editorChild.openSharedPage(childPageId);

    const marker = `\nlive edit on child before subtree rename ${Date.now()}\n`;
    await editorChild.appendText(marker);

    // Rename the PARENT with include_descendants — moves both the parent
    // and the child underneath it.
    await renamePageViaApi(userBPage.context(), { pageId: parentPageId, newPath: `${parentPath}-renamed`, includeDescendants: true });

    // AC-1/AC-41 — rename never touches `currentRevision`, so only the
    // epoch predicate can reject this save; attempt it while the
    // connection is still alive (pre-force-close).
    await editorChild.clickSave();

    // AC-39 — the CHILD's own editor gets the reload prompt (its own
    // `page-renamed` broadcast from its own per-page `Page.rename` call
    // inside `renameTree`), not just the root.
    await expect(userAPage.getByRole('alertdialog')).toBeVisible({ timeout: 15_000 });
    await expect(userAPage.locator('.cm-content').first()).toContainText(marker.trim());

    // AC-41 — the stale save never landed on the CHILD page: its persisted
    // revision body is still exactly the pre-rename content.
    await expect(async () => {
      expect(await getPageBody(userBPage.context(), childPageId)).toBe(originalChildBody);
    }).toPass({ timeout: 15_000 });
  });
});
