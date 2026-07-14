/**
 * IPC message shapes shared between spike-worker.ts (the forked child —
 * real Node ESM, native `mermaid`/`jsdom`) and the Jest-side test files
 * that fork it (via fork-spike-worker.ts).
 *
 * Why the render + verification both happen inside the worker rather
 * than in the Jest test process: `mermaid` and (transitively) `jsdom`
 * ship ESM-only leaves (e.g. `jsdom` -> `html-encoding-sniffer` ->
 * `@exodus/bytes`, `"type": "module"`, no CJS build). Jest 29's default
 * CommonJS module registry — including its handling of dynamic
 * `import()` — routes every required module (even ones reached via
 * `import()`) through its own transform pipeline, which by default
 * doesn't touch `node_modules` and can't parse `export` syntax from a
 * plain `.js` file; `packages/api/jest.config.js` works around this per
 * offending package (`transformIgnorePatterns` + a `.js`-pattern ts-jest
 * transform entry for `@scalar/hono-api-reference`) but mermaid's
 * dependency tree (d3, cytoscape, roughjs, dompurify, ...) is far larger
 * and not worth enumerating the same way for a Phase 0 spike. Running the
 * candidate in a real forked `node` process sidesteps Jest's loader
 * entirely (Node's native ESM resolver handles the whole tree correctly,
 * as proven interactively before any test code was written) — and is
 * incidentally exactly the architecture §6/§10 already commit Phase 1 to
 * (a forked child-process pool), so the spike's test harness doubles as a
 * first proof of that shape working end-to-end (§8 C).
 */

export interface LabelPosition {
  x: number;
  y: number;
}

export interface RenderRequestMessage {
  type: 'render';
  id: number;
  source: string;
}

export type RenderResponseMessage =
  | {
      type: 'render-result';
      id: number;
      ok: true;
      svg: string;
      isWellFormedSingleRootSvg: boolean;
      labelPositions: LabelPosition[];
      /** §8 B — which instrumented network vectors fired during this render. Empty for a clean render. */
      networkAttempts: string[];
    }
  | {
      type: 'render-result';
      id: number;
      ok: false;
      error: string;
      networkAttempts: string[];
    };

export interface ReadyMessage {
  type: 'ready';
}

/**
 * Sent by spike-worker.ts immediately *after* invoking `mermaid.render()`
 * (the call itself happens first, capturing the pending promise — an
 * `async function`'s body runs synchronously up to its first internal
 * `await` the instant it is called) — the one IPC-observable signal that
 * a real render call has genuinely already started (as opposed to the
 * request merely having been received). §8 C-6's SIGKILL-mid-render test
 * waits for this message and kills immediately after, using
 * __fixtures__/large-flowchart.ts's deliberately slow source so the render
 * itself is still in flight (not merely "started") when the kill lands.
 */
export interface RenderStartedMessage {
  type: 'render-started';
  id: number;
}

export type WorkerInboundMessage = RenderRequestMessage;
export type WorkerOutboundMessage = ReadyMessage | RenderStartedMessage | RenderResponseMessage;
