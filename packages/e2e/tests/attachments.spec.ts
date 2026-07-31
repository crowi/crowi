import { createPageViaApi, updatePageViaApi, uploadAttachmentViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';
import { EditorPage } from '../src/pages/editor-page';

/**
 * feature-image-derivative-optimization Phase 2 — the canonical
 * `/api/attachments/:id` URL embedded in a page body now serves
 * display-priority bytes (falling back to original when no derivative is
 * available), while the attachment detail modal always resolves the
 * explicit `/api/attachments/:id/original` escape hatch for its preview
 * and download action (spec §1/§4/§9). This is the first e2e coverage of
 * the attachment delivery flow at all (no prior spec touched it) and Phase
 * 2 rewrites the most load-bearing part of it — this spec covers, end to
 * end through a real browser:
 *   1. an image embedded in a page body renders via the canonical URL.
 *   2. opening the attachment detail modal (by clicking the embedded
 *      image) shows a download action whose `href` points at the explicit
 *      `/original` URL, not the canonical (display-priority) one.
 *
 * The upload itself goes through the real API (`uploadAttachmentViaApi`,
 * mirroring `createPageViaApi`'s native-`fetch` approach) rather than
 * driving a file-input dialog — the footer/editor upload UI flow itself is
 * not what changed in this phase, so exercising it through the browser
 * would add flake surface without adding coverage of the behaviour under
 * test. A plain 1x1 PNG is enough: whether the canonical URL ends up
 * serving `resized` or `passthrough` bytes is already covered exhaustively
 * at the API/unit level (`image-display-derivative.test.ts`,
 * `attachment.test.ts`) — this spec only needs to prove the DOM actually
 * uses the canonical/`/original` URLs it is supposed to.
 */

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');

/** English + Japanese "Download" (`page.attachment_detail_download`) — kept as a literal-key regex, matching the i18n-tolerant pattern used elsewhere (pagination.spec.ts). */
const DOWNLOAD_PATTERN = /^(Download|ダウンロード)$/;

test('an embedded image renders via the canonical URL, and the attachment detail modal download action points at /original', async ({ userAPage }) => {
  test.setTimeout(60_000);

  const token = `e2eattach${Date.now()}`;
  const pagePath = `/e2e/attachments/${token}`;
  const pageId = await createPageViaApi(userAPage.context(), {
    path: pagePath,
    body: `# Attachment display derivative\n\nSeeded by attachments.spec (${token}).\n`,
  });

  const { url } = await uploadAttachmentViaApi(userAPage.context(), {
    pageId,
    fileName: 'e2e-pixel.png',
    contentType: 'image/png',
    data: PNG_1X1,
  });

  // Embed the canonical URL directly in the body, exactly like the editor's
  // paste/insert flow would — the page-content renderer recognises it via
  // `extractAttachmentId`/`ATTACHMENT_URL_RE` regardless of how it got there.
  await updatePageViaApi(userAPage.context(), {
    pageId,
    body: `# Attachment display derivative\n\n![e2e attachment ${token}](${url})\n`,
  });

  // Scoped by alt text (not just `img[src="${url}"]`): the page footer's
  // attachment-list thumbnail (`AttachmentThumbnail`) ALSO renders an
  // `<img>` at the same canonical `src` (it deliberately stays on `url`,
  // spec §4), so a bare src selector matches 2 elements in strict mode.
  const img = userAPage.getByRole('img', { name: `e2e attachment ${token}` });

  await test.step('the embedded image renders via the canonical (display-priority) URL', async () => {
    await userAPage.goto(pagePath);
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', url);
    // A successfully decoded, non-zero natural width proves the browser
    // actually received real image bytes back from the canonical URL (not
    // a broken/placeholder response) — the byte-level resized/passthrough
    // distinction itself is covered at the API/unit level, not here.
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  await test.step('clicking the embedded image opens the attachment detail modal, whose download action href points at /original (not the canonical url)', async () => {
    await img.click();
    const downloadLink = userAPage.getByRole('link', { name: DOWNLOAD_PATTERN });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute('href', `${url}/original`);
  });
});

/**
 * feature-attachment-upload-policy — regression coverage for the reported
 * symptom itself: the SAME file type uploaded fine via the "Attach file"
 * button (`POST /pages/:pageId/attachments`, which had no MIME check at
 * all) while being rejected by the editor's drag-and-drop path (`POST
 * /attachments/upload`, whose old `DND_ALLOWED_MIME` did not include office
 * documents). Both affordances now check the same unified
 * `UPLOAD_ALLOWED_MIME` allow-list, so both a `.docx` and the originally
 * reported `text/html` file must succeed identically from either
 * real-browser affordance — this is the first e2e coverage to
 * actually drive the attach-button file input and a synthetic editor drop,
 * rather than uploading via the API directly (see the top-of-file note on
 * why the OTHER test above uses the API instead: that one is not testing
 * this parity).
 */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The two types exercised through both affordances: `.docx` (rejected by
 * the old D&D-only allow-list, the everyday-business-file case) and
 * `text/html` (the file type of the originally reported symptom). The
 * bytes are stubs, not byte-valid documents — the upload policy only
 * inspects the declared Content-Type / filename, never the contents, so a
 * small buffer exercises the same code path.
 */
const PARITY_CASES = [
  { label: '.docx', ext: 'docx', mime: DOCX_MIME, bytes: Buffer.from('PK stub docx contents for the attachment-upload-policy e2e regression test') },
  { label: 'text/html', ext: 'html', mime: 'text/html', bytes: Buffer.from('<!doctype html><title>stub</title>') },
] as const;

test('.docx and text/html upload identically via the attach button and via editor drag-and-drop (button-ok/dnd-rejected symptom no longer reproduces)', async ({
  userAPage,
}) => {
  test.setTimeout(90_000);

  const token = `e2eattachpolicy${Date.now()}`;
  const pagePath = `/e2e/attachment-upload-policy/${token}`;
  const pageId = await createPageViaApi(userAPage.context(), {
    path: pagePath,
    body: `# Attachment upload policy parity\n\nSeeded by attachments.spec (${token}).\n`,
  });

  const editor = new EditorPage(userAPage);
  await editor.openSharedPage(pageId);
  const content = userAPage.locator('.cm-content').first();

  for (const { label, ext, mime, bytes } of PARITY_CASES) {
    await test.step(`attach button: the file input accepts the ${label} file and inserts a markdown link`, async () => {
      const buttonFileName = `button-${token}.${ext}`;
      await userAPage.locator('input[type="file"]').setInputFiles({
        name: buttonFileName,
        mimeType: mime,
        buffer: bytes,
      });
      await expect(content).toContainText(`[${buttonFileName}]`, { timeout: 15_000 });
    });

    await test.step(`drag-and-drop: the SAME ${label} file type uploads via the editor drop target too — previously rejected here (the reported symptom)`, async () => {
      const dropFileName = `dnd-${token}.${ext}`;
      await content.click();
      await userAPage.keyboard.press('End');

      const dataTransfer = await userAPage.evaluateHandle(
        ({ base64, name, type }) => {
          const binary = atob(base64);
          const buffer = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
          const file = new File([buffer], name, { type });
          const dt = new DataTransfer();
          dt.items.add(file);
          return dt;
        },
        { base64: bytes.toString('base64'), name: dropFileName, type: mime },
      );

      await content.dispatchEvent('drop', { dataTransfer });
      await expect(content).toContainText(`[${dropFileName}]`, { timeout: 15_000 });
    });
  }
});
