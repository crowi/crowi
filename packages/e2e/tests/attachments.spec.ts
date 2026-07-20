import { createPageViaApi, updatePageViaApi, uploadAttachmentViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * feature-image-derivative-optimization Phase 2 — the canonical
 * `/api/v2/attachments/:id` URL embedded in a page body now serves
 * display-priority bytes (falling back to original when no derivative is
 * available), while the attachment detail modal always resolves the
 * explicit `/api/v2/attachments/:id/original` escape hatch for its preview
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
