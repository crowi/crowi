/**
 * Standalone `fork()`ed worker used only by `render-engine.test.ts`'s
 * "recovers after a timeout — the respawned worker serves the next render
 * successfully" test (spec §6 AC: timeout → SIGKILL → respawn does not
 * break the pool). That test previously forked the REAL `render-worker.ts`
 * against a genuinely slow diagram to force a real timeout, then measured
 * whether the respawned worker's own first (trivial) render finished within
 * the same short timeout budget — real Mermaid render time (plus a fresh
 * worker's module/JIT warmup) made that budget tight enough to flake under
 * CI/sibling-suite CPU contention even though the protocol under test
 * (timeout → kill → respawn → next render succeeds) has nothing to do with
 * how fast a render actually is.
 *
 * This fixture decouples the two: it deliberately never imports
 * mermaid/jsdom (same reasoning as `idle-crash-worker.ts` — starts and
 * answers near-instantly), and DELIBERATELY NEVER REPLIES to the first
 * render request it receives — forcing the pool's own timeout to fire for a
 * reason that has nothing to do with real render latency, so the test's
 * timeout budget only needs to be "long enough to prove nothing replies",
 * not "long enough to run a real slow render safely under CI load". The
 * respawned instance (a fresh process, since a timeout kills the child)
 * replies to its first render immediately with a fixed trivial SVG.
 *
 * Distinguishing "am I the original (should hang) or the respawned
 * replacement (should reply)?" needs a channel that survives across the
 * kill+refork, since `render-engine.ts`'s `spawn()` forks the identical
 * `workerPath` with no generation/attempt info passed as an argument. An
 * env var looked like the obvious choice (the test sets one before calling
 * `render()`, `fork()` is documented to inherit `process.env` by default) —
 * but does NOT work here: verified empirically that under ts-jest
 * (`testEnvironment: 'node'`), a `process.env` mutation made from inside a
 * test is invisible to a REAL `fork()`ed child, even though the SAME test
 * process reads its own mutation back correctly (jest's Node test
 * environment does not give `child_process.fork()` the same `process.env`
 * view test code sees). So this uses a temp-file PATH instead, keyed by
 * `process.ppid` — the pid of whichever process called `fork()` (the jest
 * worker process running this test file) — so two `render-engine.test.ts`
 * runs on the same machine (e.g. two worktrees' `pnpm test` running
 * concurrently, or a CI job overlapping a local run) never share a sentinel.
 * `render-engine.ts`'s `spawn()` forks this file directly from the test
 * process, so `process.ppid` here always equals `process.pid` there — the
 * test computes the identical path from its own pid with no IPC needed.
 * Present ⇒ this is a respawned instance (reply normally); absent ⇒ this is
 * the original (create it, then go silent). The test removes it before and
 * after each run so state never leaks across runs of the same process.
 *
 * Deliberately has no `import`/`export` — same reasoning as
 * `signal-killed-worker.ts`/`idle-crash-worker.ts`'s doc comments: this
 * file needs nothing beyond `process` and `node:fs`/`node:os`/`node:path`,
 * so it stays plain CommonJS-shaped source rather than needing the ESM
 * workarounds `render-worker.ts` documents for its own (genuinely
 * ESM-only, `mermaid`-importing) case.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sentinelPath = path.join(os.tmpdir(), `crowi-mermaid-recovery-fixture-${process.ppid}.sentinel`);
const isFirstSpawn = !fs.existsSync(sentinelPath);
if (isFirstSpawn) {
  fs.writeFileSync(sentinelPath, '');
}

process.on('message', (msg: unknown) => {
  const inbound = msg as { type?: string; id?: number } | null;
  if (!inbound || inbound.type !== 'render') return;
  if (isFirstSpawn) return; // deliberately silent — forces the pool's own timeout
  process.send?.({ type: 'render-result', id: inbound.id, ok: true, svg: '<svg><text>recovery-fixture-worker reply</text></svg>' });
});

process.send?.({ type: 'ready' });
