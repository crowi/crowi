import { expect, type Page } from '@playwright/test';

/**
 * Page object for the collaborative editor at `/_edit?page_id=<id>`. The
 * CodeMirror surface is `.cm-content`; readiness is gated on it becoming
 * contenteditable (the collab session reached `synced` and mounted the
 * editor) so typing isn't lost against a pre-sync doc.
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

  async waitUntilEditable(): Promise<void> {
    const content = this.content();
    await content.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(content).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  }

  async appendText(text: string): Promise<void> {
    const content = this.content();
    await content.click();
    await this.page.keyboard.press('End');
    await this.page.keyboard.type(text);
  }

  async waitForText(text: string): Promise<void> {
    await this.page.waitForFunction((needle) => document.querySelector('.cm-content')?.textContent?.includes(needle) ?? false, text, { timeout: 30_000 });
  }
}
