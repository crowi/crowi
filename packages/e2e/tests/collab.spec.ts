import { test } from '../src/fixtures';
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
