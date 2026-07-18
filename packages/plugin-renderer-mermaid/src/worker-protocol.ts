/**
 * IPC message shapes between `render-engine.ts` (parent-process pool
 * manager) and `render-worker.ts` (the forked child). Deliberately a
 * much smaller surface than Phase 0's `__fixtures__/spike-protocol.ts` —
 * production doesn't need the spike's verification payload
 * (`isWellFormedSingleRootSvg` / `labelPositions` / `networkAttempts`),
 * only the rendered SVG string or an error. The messages carry only
 * plain strings/numbers/booleans, so Node's default JSON-based IPC
 * serialization is sufficient (no structured-clone / shared-memory
 * needed — spec §10).
 */

export interface RenderRequestMessage {
  type: 'render';
  id: number;
  source: string;
}

export type RenderResponseMessage =
  | { type: 'render-result'; id: number; ok: true; svg: string }
  | { type: 'render-result'; id: number; ok: false; error: string };

export interface ReadyMessage {
  type: 'ready';
}

export type WorkerOutboundMessage = ReadyMessage | RenderResponseMessage;
