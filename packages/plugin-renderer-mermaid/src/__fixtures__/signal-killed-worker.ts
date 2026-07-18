/**
 * Standalone `fork()`ed worker used only by `render-engine.test.ts`'s
 * "worker startup crash handling" suite. Reproduces a worker that is torn
 * down by a *signal* before it ever sends its `ready` message — the same
 * observable shape (`exit` fires with `code === null`) as a real
 * `render-worker.ts` process killed mid-startup by an OOM killer or a
 * container runtime's `SIGKILL`/`SIGTERM`, which `render-engine.ts`'s
 * `spawn()` must reject on rather than hang waiting for a `ready` that
 * will never arrive (spec §5 classification B: an infra failure the
 * caller must be able to recover from, not a silent stall).
 *
 * Deliberately has no `import`/`export` — this file needs nothing beyond
 * the `process` global, so it stays plain CommonJS-shaped source (Node's
 * syntax-detection for an untyped `.ts` file only switches to ESM parsing
 * when it sees `import`/`export` syntax) rather than needing the ESM
 * workarounds `render-worker.ts` / `spike-worker.ts` document for their
 * own (genuinely ESM-only, `mermaid`-importing) cases.
 */
process.kill(process.pid, 'SIGKILL');
