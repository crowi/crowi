import { expect, type Page } from '@playwright/test';

/**
 * Page object for the collaborative editor at `/_edit?page_id=<id>`. The
 * CodeMirror surface is `.cm-content`; readiness is gated on it no longer
 * being read-only (the collab session reached `synced` and mounted the
 * writable editor) so typing isn't lost against a pre-sync doc.
 */
export class EditorPage {
  constructor(private readonly page: Page) {}

  private content() {
    // The editor mounts two CodeMirror panes for responsive layouts (wide /
    // narrow). They share the same Y.Text; target the first concrete surface to
    // avoid Playwright strict-mode ambiguity.
    return this.page.locator('.cm-content').first();
  }

  async openSharedPage(pageId: string): Promise<void> {
    await this.page.goto(`/_edit?page_id=${encodeURIComponent(pageId)}`);
    await this.waitUntilEditable();
  }

  /**
   * Resolves once the editor accepts input. `contenteditable` alone is not
   * that signal: the editor mounts before the collab session's first sync
   * with `EditorState.readOnly` on, and CodeMirror keeps `contenteditable`
   * at `"true"` under `readOnly` (it only sets `aria-readonly="true"` and
   * drops DOM edits). Waiting on `contenteditable` therefore returned on the
   * empty pre-sync editor, and everything typed before SyncStep2 landed was
   * silently discarded — which made every collab assertion downstream a race
   * against the WebSocket handshake. `aria-readonly` is the attribute that
   * actually tracks writability.
   *
   * A positive selector, not a negated assertion: the writable editor is a
   * fresh mount that replaces the pre-sync one, and a negated attribute
   * assertion would also pass in the gap where no `.cm-content` exists yet.
   */
  async waitUntilEditable(): Promise<void> {
    await this.page.locator('.cm-content[contenteditable="true"]:not([aria-readonly="true"])').first().waitFor({ state: 'visible', timeout: 30_000 });
  }

  async appendText(text: string): Promise<void> {
    const content = this.content();
    await content.click();
    await this.page.keyboard.press('End');
    await this.page.keyboard.type(text);
    // Fail here, at the step that lost the text, rather than in whichever
    // later assertion happens to depend on it.
    await expect(content).toContainText(text.trim());
  }

  async waitForText(text: string): Promise<void> {
    await this.page.waitForFunction((needle) => document.querySelector('.cm-content')?.textContent?.includes(needle) ?? false, text, { timeout: 30_000 });
  }

  /**
   * Click the realtime Save button (`crowi:save` over the collab session).
   *
   * RFC-0017 Phase 1 — this is deliberately a JS-level `element.click()`
   * (via `locator.evaluate`), not a simulated Playwright mouse click: a
   * stale-save assertion wants to attempt the save regardless of whether a
   * `CollabForceReloadDialog` (Radix `AlertDialog`) has already opened and
   * visually covers the footer — the button itself stays enabled (nothing
   * auto-disables Save on a force-reload broadcast, only the eventual
   * connection close after the drain grace does), so a real click still
   * reaches its `onClick` handler. A regular Playwright `.click()` would
   * instead fail the actionability check ("subject to pointer-event
   * interception") once the dialog's overlay is on top, making the race
   * with the broadcast flaky.
   */
  async clickSave(): Promise<void> {
    // Locate by innerText (not accessible name / role name) — the Save
    // button's icon child is decorative (`aria-hidden`), but matching on
    // rendered text is simpler and avoids any accname-computation edge case.
    const button = this.page.locator('footer button', { hasText: /^(Save|保存)$/ }).first();
    await button.evaluate((el) => (el as HTMLButtonElement).click());
  }
}
