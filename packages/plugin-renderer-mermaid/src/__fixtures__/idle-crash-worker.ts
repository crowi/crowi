/**
 * Standalone `fork()`ed worker used only by `render-engine.test.ts`'s
 * "idle worker crash → immediate respawn" test (spec §10 (b) / AC:
 * "クラッシュ検知 + 即時再生成"). Unlike `signal-killed-worker.ts` (crashes
 * BEFORE ever sending `ready`) or a mid-`dispatch()` crash (a job is
 * pending when the child dies), this fixture answers the render-worker
 * protocol normally — sends `ready`, then replies to a `render` request
 * with a fixed trivial SVG — and only self-`SIGKILL`s some time AFTER
 * that reply, once it is genuinely idle with no job in flight. This
 * reproduces a spontaneous crash between renders (an OOM kill, a native
 * crash in a dependency, etc.), the one case `render-engine.ts`'s
 * `dispatch()` has no in-flight call to notice via its own `catch` block
 * — only the persistent `exit` handler installed in `spawn()` can catch
 * it.
 *
 * Deliberately does not import `mermaid`/jsdom (the reply is a fixed
 * string, not a real render) so this worker starts and answers
 * near-instantly, keeping the test's timing budget tight and reliable
 * under CI/sibling-suite load.
 *
 * Deliberately has no `import`/`export` — same reasoning as
 * `signal-killed-worker.ts`'s doc comment: this file needs nothing
 * beyond the `process` global, so it stays plain CommonJS-shaped source
 * rather than needing the ESM workarounds `render-worker.ts` documents
 * for its own (genuinely ESM-only, `mermaid`-importing) case.
 */

/** Comfortably shorter than the test's own wait, longer than any reply round-trip. */
const SELF_DESTRUCT_AFTER_MS = 150;

process.on('message', (msg: unknown) => {
  const inbound = msg as { type?: string; id?: number } | null;
  if (!inbound || inbound.type !== 'render') return;
  process.send?.({ type: 'render-result', id: inbound.id, ok: true, svg: '<svg><text>idle-crash-worker reply</text></svg>' });
});

process.send?.({ type: 'ready' });

setTimeout(() => {
  process.kill(process.pid, 'SIGKILL');
}, SELF_DESTRUCT_AFTER_MS);
