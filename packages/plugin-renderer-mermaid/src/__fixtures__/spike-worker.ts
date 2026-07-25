/**
 * Phase 0 spike's forked worker entry point
 * (.feature-state/specs/feature-plugin-renderer-mermaid.md §8).
 *
 * Forked directly by fork-spike-worker.ts via `node:child_process`'s
 * `fork()` — this file is a real `node <path>.ts` process, never loaded
 * through Jest (see spike-protocol.ts for why). It installs the DOM shim
 * + network instrumentation, loads `mermaid` once, then answers
 * `render` requests over IPC.
 *
 * Runs as ESM even though the extension is plain `.ts` (no
 * `package.json: "type": "module"` in this package): Node's native
 * TypeScript support determines a `.ts` file's module system by
 * syntax-detection when the nearest `package.json` doesn't declare a
 * `"type"` — a file using top-level `import`/`export` (this one does, it
 * needs real ESM to statically import an ESM-only package transitively
 * via jsdom) gets reparsed as ESM automatically, with a one-time
 * `[MODULE_TYPELESS_PACKAGE_JSON]` advisory on stderr.
 * fork-spike-worker.ts's `fork()` call passes `--no-warnings` to suppress
 * that advisory (cosmetic only, not a behavior difference) — extension
 * stays `.ts` on purpose so Biome's formatter (which only matches
 * `*.{ts,tsx,js,jsx}`, not `.mts`) still covers this file.
 */

import { installMermaidDomEnv } from './mermaid-dom-env.ts';
import { getNetworkAttempts, installNetworkInstrumentation, resetNetworkAttempts } from './network-instrumentation.ts';
import type { RenderRequestMessage, RenderResponseMessage } from './spike-protocol.ts';
import { extractLabelPositions, isWellFormedSingleRootSvg } from './svg-inspect.ts';

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
}

async function main(): Promise<void> {
  // Order matters, both ways: the DOM env must be installed first so
  // `globalThis.Image`/`XMLHttpRequest`/`fetch` actually exist for
  // network-instrumentation to wrap (jsdom is what defines them — there
  // is no built-in `Image` global to patch beforehand); network
  // instrumentation must then be installed before `mermaid` is imported
  // at all, so even a network reach attempted at mermaid's module-init
  // time (not just at render time) would be caught.
  installMermaidDomEnv();
  installNetworkInstrumentation();

  // mermaid ships ESM-only — a real `import()` in this genuinely-ESM
  // worker resolves it natively (no Jest loader involved here).
  const mod = (await import('mermaid')) as unknown as { default: MermaidApi };
  const mermaid = mod.default;

  // Mirrors the §2 layer-1 host-forced settings this candidate would run
  // under in Phase 1 (strict security, no HTML labels, fixed theme) — the
  // spike validates the config Crowi actually intends to ship.
  // `gantt.useWidth`: see `render-worker.ts`'s `MERMAID_INIT_CONFIG` doc
  // comment — jsdom's `offsetWidth` always reads `0` (not `undefined`),
  // so the Gantt renderer's own `w === void 0` fallback never fires.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    gantt: { useWidth: 1200 },
    theme: 'base',
  });

  process.on('message', async (msg: RenderRequestMessage) => {
    if (msg.type !== 'render') return;
    resetNetworkAttempts();

    let response: RenderResponseMessage;
    try {
      // Call render() *first*, capturing the pending promise, and only
      // then tell the parent a render call has started (see
      // spike-protocol.ts's RenderStartedMessage doc comment). An
      // `async function`'s body runs synchronously up to its first
      // internal `await` the instant it is invoked, so by the time
      // `process.send` below runs, `mermaid.render()` has
      // unconditionally already begun executing — there is no gap in
      // which the parent could receive `render-started` and kill the
      // child before render() was ever called. An earlier version sent
      // `render-started` *before* calling render(), with an artificial
      // `setImmediate` delay in between; a SIGKILL landing in that gap
      // would have made `renderCompletedBeforeKill === false` true
      // without render() having been called at all, which does not
      // prove a mid-render kill.
      const renderPromise = mermaid.render(`spike-${msg.id}`, msg.source);
      process.send?.({ type: 'render-started', id: msg.id });
      const { svg } = await renderPromise;
      response = {
        type: 'render-result',
        id: msg.id,
        ok: true,
        svg,
        isWellFormedSingleRootSvg: isWellFormedSingleRootSvg(svg),
        labelPositions: extractLabelPositions(svg),
        networkAttempts: getNetworkAttempts(),
      };
    } catch (err) {
      response = {
        type: 'render-result',
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        networkAttempts: getNetworkAttempts(),
      };
    }
    process.send?.(response);
  });

  process.send?.({ type: 'ready' });
}

main().catch((err: unknown) => {
  // A startup failure (e.g. mermaid import blowing up) has no request to
  // respond to yet — surface it on stderr and exit non-zero so the
  // parent's `fork()` caller sees a clear failure instead of a silent
  // hang waiting for a `ready` message that will never come.
  console.error('spike-worker failed to start', err);
  process.exitCode = 1;
});
