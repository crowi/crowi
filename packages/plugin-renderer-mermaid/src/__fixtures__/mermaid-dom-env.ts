/**
 * Phase 0 spike entry point for the "browserless DOM shim" — now a
 * re-export of the production installer (`../dom-env.ts`), which is the
 * hardened descendant of the polyfill this file originally carried.
 * Kept as a separate module only so `spike-worker.ts` keeps its Phase 0
 * shape; the polyfill itself must not exist twice (a getBBox fix that
 * lands only on one copy silently invalidates whichever tests exercise
 * the other).
 *
 * Historical note (spec §8, recorded during the spike): jsdom implements
 * no SVG layout, so `getBBox`/`getComputedTextLength` need a real
 * geometry-aware polyfill. A naive "size from textContent.length" stub
 * also clears gate A's mechanical checks, but produces nonsense the
 * moment `getBBox()` is called on a container (a 2-node flowchart came
 * out ~31,000px wide vs ~280x410 with the geometry-aware version) —
 * which is why the production polyfill unions child boxes offset by each
 * child's own `transform="translate(x,y)"`.
 */
export { installMermaidDomEnv } from '../dom-env.ts';
