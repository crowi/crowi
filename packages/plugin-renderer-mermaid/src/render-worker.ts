/**
 * Production `fork()` entry point for the Mermaid child-process render
 * pool (spec §6 / §10). Forked directly by `render-engine.ts`.
 *
 * Runs as ESM even though the extension is plain `.ts` (no
 * `package.json: "type": "module"` declared) — Node's native TypeScript
 * support determines a `.ts` file's module system by syntax-detection
 * when the nearest `package.json` doesn't declare a `"type"`, and this
 * file's top-level `import`/`export` syntax gets it reparsed as ESM
 * automatically (same mechanism, same reasoning, as Phase 0's
 * `__fixtures__/spike-worker.ts` — see that file's doc comment for the
 * full explanation of why: `mermaid` and `jsdom` both ship ESM-only
 * leaves that only resolve correctly through Node's own ESM loader).
 * `render-engine.ts` forks this exact `.ts` file directly in dev/test
 * (no build step) and the tsup-built `dist/render-worker.js` (CJS) in
 * production — see that file's `resolveWorkerEntryPath` for how the
 * choice is made, and spec §10's "CJS/ESM でのworkerパス解決戦略" for why
 * the CJS build is what actually ships (the runner always
 * `require()`s the plugin's `dist/index.js`, so `__dirname`-relative
 * sibling resolution from there always lands on this file's CJS output).
 */

// Explicit `.ts` extensions below (not the usual extension-less relative
// import) — required for Node's native ESM resolver when this file is
// forked directly as `.ts` (dev/test, before `tsup` has run; see this
// file's header comment). `tsup`/esbuild resolve an explicit `.ts`
// extension on a relative specifier fine for the built (CJS/ESM) output,
// so this works in both modes — same convention Phase 0's
// `__fixtures__/spike-worker.ts` uses for the same reason.
import { installMermaidDomEnv } from './dom-env.ts';
import { installDenyByDefaultNetworkBoundary } from './network-boundary.ts';
import type { RenderRequestMessage, RenderResponseMessage } from './worker-protocol.ts';

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
}

/**
 * spec §1 layer 1 — the host-forced Mermaid config, applied exactly
 * once at worker startup and never overridable per-call (§1: "呼び出し
 * ごとの引数では変更できない"). Mirrors Phase 0's
 * `__fixtures__/spike-worker.ts` config, which is what the compatibility
 * gates (§8) were actually validated against.
 *
 * `gantt.useWidth` (regression fix): the Gantt renderer reads
 * `elem.parentElement.offsetWidth` to size the chart
 * (`ganttDiagram-*.mjs`'s `draw()`), falling back to `1200` only when
 * that read is `undefined` — but jsdom's `offsetWidth` (no real layout
 * engine) always returns `0`, not `undefined`, so that fallback never
 * fires and every Gantt chart gets laid out against a 0px budget,
 * producing a negative-width/zero-`viewBox` SVG that fails to render.
 * `useWidth` is Mermaid's own documented escape hatch for exactly this
 * ("no real container to measure") case — set it to the same `1200`
 * Mermaid's own fallback intended.
 */
const MERMAID_INIT_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  gantt: { useWidth: 1200 },
  theme: 'base',
} as const;

async function main(): Promise<void> {
  // Order matters, both ways (spec §10): the DOM env must be installed
  // first so `document`/`window`-scoped globals (and jsdom's own
  // `XMLHttpRequest`) actually exist before the network boundary tries
  // to override them; the network boundary must then be installed
  // before `mermaid` is imported at all, so even a network reach
  // attempted at mermaid's module-init time (not just at render time)
  // would fail closed.
  installMermaidDomEnv();
  installDenyByDefaultNetworkBoundary();

  // mermaid ships ESM-only — a real `import()` in this genuinely-ESM
  // worker resolves it natively.
  const mod = (await import('mermaid')) as unknown as { default: MermaidApi };
  const mermaid = mod.default;
  mermaid.initialize(MERMAID_INIT_CONFIG);

  process.on('message', async (msg: RenderRequestMessage) => {
    if (msg.type !== 'render') return;

    let response: RenderResponseMessage;
    try {
      const { svg } = await mermaid.render(`crowi-mermaid-${msg.id}`, msg.source);
      response = { type: 'render-result', id: msg.id, ok: true, svg };
    } catch (err) {
      response = { type: 'render-result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    process.send?.(response);
  });

  process.send?.({ type: 'ready' });
}

main().catch((err: unknown) => {
  // A startup failure (e.g. mermaid import blowing up) has no request
  // to respond to yet — surface it on stderr and exit non-zero so the
  // parent's `fork()` caller sees a clear failure instead of a silent
  // hang waiting for a `ready` message that will never come.
  console.error('render-worker failed to start', err);
  process.exitCode = 1;
});
