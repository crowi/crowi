/**
 * Test-only fixture plugin for Phase 4 e2e tests. Provides a single
 * embed-tag `@[echo](payload)` that renders the trivial
 * `<div class="echo">payload</div>` so we can validate the parse →
 * cache miss → render → cache set → re-read flow end-to-end without
 * a real I/O plugin.
 *
 * **MUST NOT be imported from production code paths.** This file lives
 * under `__fixtures__/` to make the boundary visible to humans /
 * code reviewers. The `render()` function additionally probes
 * `process.env.NODE_ENV` and throws when invoked outside of `test`
 * so an accidental production import surfaces immediately on first
 * call (rather than silently shipping a debug-only renderer).
 *
 * Will be removed once Phase 6/7 ships a real plugin (PlantUML /
 * KaTeX / Mermaid / GitHub Embed).
 */
import type { EmbedRenderer } from '@crowi/plugin-api';

export const ECHO_TAG = 'echo';

/** Bump if the fixture's output shape changes; not exercised but kept for parity with real plugins. */
export const ECHO_CACHE_VERSION = 1;

/**
 * Simple `@[echo](payload)` → `<div class="echo">payload</div>` renderer.
 * The output html is HTML-escape-free on purpose — payloads in tests
 * are controlled and the assertion targets the verbatim string.
 */
export const echoEmbedRenderer: EmbedRenderer = {
  cacheVersion: ECHO_CACHE_VERSION,
  render: async (input) => {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('[crowi:renderer:__fixtures__/echo-embed] This fixture plugin is for tests only. Do not register it from production code.');
    }
    return {
      html: `<div class="echo">${input.url}</div>`,
      ttlSec: 300,
    };
  },
};
