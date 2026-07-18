/**
 * Phase 0 gate B — no-network verification
 * (.feature-state/specs/feature-plugin-renderer-mermaid.md §8 B).
 *
 * While rendering the 8-diagram corpus, this asserts that none of
 * `Image` / `fetch` / `XMLHttpRequest` / DNS lookup / socket connect ever
 * fire (__fixtures__/network-instrumentation.ts installs the hooks
 * inside the forked worker — see __fixtures__/spike-protocol.ts for why
 * rendering happens in a forked process rather than in-process).
 *
 * It also confirms the instrumentation actually *works* as a detector,
 * not just as an "it happened to stay quiet" observation: a diagnostic
 * source that bypasses §3's (not-yet-implemented, Phase 1) input-side
 * rejection and uses the flowchart image-shape construct
 * (`@{ img: "..." }`) is rendered directly, and the same instrumentation
 * must catch the resulting `new Image()` / `.src=` / `.decode()` reach
 * attempt. §8 B frames this as the "if §3's denylist ever has a gap, does
 * the runtime itself still refuse to reach the network" layer of
 * defense-in-depth (distinct from — and validated independently of —
 * §3's source-level rejection, which Phase 1 implements).
 */

import { DIAGNOSTIC_IMAGE_SHAPE_SOURCE, DIAGRAM_CORPUS } from './__fixtures__/diagram-corpus';
import { forkSpikeWorker, type SpikeWorker } from './__fixtures__/fork-spike-worker';

/**
 * §3(b) / §8 B deliverable: the concrete Mermaid source construct(s)
 * confirmed by this spike to reach for a browser network API mid-render,
 * for Phase 1's input-side denylist (§3(b)). Recorded here as a
 * structured, code-native artifact per architecturalNotes (no separate
 * *.md file) — this is the "確定リスト" §3(b) says Phase 0 must hand off.
 *
 * Each entry's `pattern` is the literal shape-data key that triggers the
 * reach (confirmed via source inspection of
 * `mermaid/dist/chunks/mermaid.core/shapes/imageSquare.ts`: any flowchart
 * vertex with an `img` key gets typed as the `imageSquare` shape, whose
 * renderer unconditionally does `new Image(); img.src = node.img; await
 * img.decode();` — no further gating). Phase 1 must reject any Mermaid
 * source containing this key inside a `@{ ... }` shape-data block,
 * scanning the *entire* source string per §3(a)'s same "not just the
 * first line" reasoning (a vertex definition can appear anywhere).
 */
export const CONFIRMED_NETWORK_REACH_PATTERNS: ReadonlyArray<{ pattern: string; reason: string; example: string }> = [
  {
    pattern: 'img',
    reason:
      'A flowchart vertex shape-data block containing an `img` key ' +
      '(`A@{ img: "..." }`) is classified as the `imageSquare` shape ' +
      '(mermaid getTypeFromVertex: `if (vertex.img) return "imageSquare"`), ' +
      'whose renderer does `new Image(); img.src = node.img; await img.decode();` ' +
      'unconditionally — no config flag suppresses this.',
    example: DIAGNOSTIC_IMAGE_SHAPE_SOURCE,
  },
];

describe('Phase 0 gate B: no-network verification (mermaid + jsdom)', () => {
  let worker: SpikeWorker;
  let nextId = 1;

  beforeAll(async () => {
    worker = await forkSpikeWorker();
  }, 30_000);

  afterAll(() => {
    worker?.kill();
  });

  it.each(
    DIAGRAM_CORPUS.map((entry) => [entry.name, entry.source] as const),
  )('%s never triggers Image/fetch/XMLHttpRequest/DNS/socket instrumentation', async (name, source) => {
    const result = await worker.render({ id: nextId++, source });
    if (!result.ok) {
      throw new Error(`${name} failed to render: ${result.error}`);
    }
    expect(result.networkAttempts).toEqual([]);
  });

  it('detects the bypassed diagnostic image-shape source reaching for Image/src/decode', async () => {
    const result = await worker.render({ id: nextId++, source: DIAGNOSTIC_IMAGE_SHAPE_SOURCE });

    // The diagnostic source is expected to fail render (jsdom's Image
    // doesn't complete a real load either) — what matters for gate B is
    // that the *attempt* was observed before that failure, not whether
    // the render itself succeeded.
    expect(result.networkAttempts.length).toBeGreaterThan(0);
    expect(result.networkAttempts.some((a) => a.startsWith('Image#constructor'))).toBe(true);
  });

  it('CONFIRMED_NETWORK_REACH_PATTERNS is non-empty (Phase 1 §3(b) denylist handoff)', () => {
    expect(CONFIRMED_NETWORK_REACH_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of CONFIRMED_NETWORK_REACH_PATTERNS) {
      expect(entry.example).toContain(entry.pattern);
    }
  });
});
