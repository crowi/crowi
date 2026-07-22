/**
 * Test-only fixture standing in for the two real diagram
 * `CodeBlockRenderer`s (`@crowi/plugin-renderer-plantuml`,
 * `@crowi/plugin-renderer-mermaid`): same registry/pipeline/cache
 * extension point (`addCodeBlockRenderer`), same `RenderResult`
 * success/error contract, same `diagram-embed`
 * `data-crowi-renderer-presentation="diagram"
 * data-crowi-renderer-state="ready"` output shape (spec §3.1) —
 * driven by an injectable `render` callback so a test can flip
 * success/failure between calls exactly like the real fixtures used
 * to mock an outbound `fetch` (feature-renderer-plugin-boundary
 * Phase 2 §1/§4 — API-core generic-registry/cache/pipeline coverage of
 * an optional plugin's registration mechanics moves to local fakes;
 * the real plugins' production seam — real HTTP/child-process
 * rendering, sanitization, cacheVersion-bump semantics — moves to
 * `packages/e2e/tests/renderer-plugins.spec.ts` and stays covered
 * independently by each plugin's own unit/dist-boot test suite).
 *
 * **MUST NOT be imported from production code paths.** Same
 * `NODE_ENV==='test'` guard as `echo-embed.ts`.
 */
import type { CodeBlockInfo, CodeBlockRenderer, RenderContext, RenderResult } from '@crowi/plugin-api';

export interface FakeDiagramRendererOptions {
  cacheVersion?: number;
  previewPolicy?: CodeBlockRenderer['previewPolicy'];
  admissionControl?: CodeBlockRenderer['admissionControl'];
}

/**
 * Build a `CodeBlockRenderer` whose `render()` delegates to `renderImpl`
 * — pass a `jest.fn()` (or any async function) so the test controls
 * success/error/timing per call, the same shape `plantuml.e2e.test.ts` /
 * `mermaid.e2e.test.ts` drove via a mocked `fetch` before conversion.
 */
export function createFakeDiagramRenderer(
  renderImpl: (info: CodeBlockInfo, ctx: RenderContext) => Promise<RenderResult>,
  options: FakeDiagramRendererOptions = {},
): CodeBlockRenderer {
  return {
    cacheVersion: options.cacheVersion ?? 1,
    reservation: { variant: 'aspect', aspectRatio: 16 / 9 },
    previewPolicy: options.previewPolicy,
    admissionControl: options.admissionControl,
    async render(info, ctx) {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error(
          '[crowi:renderer:__fixtures__/fake-diagram-code-block] This fixture plugin is for tests only. Do not register it from production code.',
        );
      }
      return renderImpl(info, ctx);
    },
  };
}

/** A success `RenderResult` shaped exactly like the real diagram plugins' new data contract (spec §3.1). */
export function fakeDiagramReadyResult(body: string, ttlSec = 3600): RenderResult {
  return {
    html: `<div class="diagram-embed fake-diagram-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready">${body}</div>`,
    ttlSec,
  };
}

/** An error `RenderResult` shaped like the real diagram plugins' outbound-failure output (network/timeout/unknown). */
export function fakeDiagramErrorResult(code: 'network' | 'timeout' | 'not_found' | 'unknown', message: string): RenderResult {
  return { html: '', error: { code, message } };
}
