/**
 * Request-boundary ring buffer (feature-flake-failure-taxonomy AC-2).
 *
 * `setup.ts`'s `fetchFn` (the ONLY place a supertest request reaches
 * `honoApp.fetch`) pushes one entry here per dispatched request and updates
 * it once a response (or a thrown error) resolves. This module is imported
 * by `setup.ts` — i.e. it runs INSIDE the vm context `jest-environment-node`
 * builds for the test file (ts-jest-transformed, same module registry as
 * the test file itself), which is a SEPARATE module system from
 * `crowi-environment.js`'s `handleTestEvent` (plain CJS, loaded via Node's
 * native `require` outside jest's per-file Runtime — see that file's doc
 * comment). Those two therefore cannot share an ordinary JS module-level
 * variable.
 *
 * The bridge: `NodeEnvironment` exposes the vm context as `this.global` on
 * the environment INSTANCE, and `handleTestEvent` runs as a method bound to
 * that same instance (`environment.handleTestEvent.bind(environment)` —
 * `jest-circus`'s `jestAdapterInit.js`) — so `this.global` INSIDE
 * `handleTestEvent` IS the exact object this module's `globalThis` resolves
 * to inside the test file. This mirrors the pattern `crowi-environment.js`'s
 * `setup()` already uses to hand values across the same boundary
 * (`this.global.MONGO_URI = this.mongoUri`, read back in `setup.ts` as
 * `global.MONGO_URI`). Storing the ring buffer under a fixed, well-known key
 * on `globalThis` — `GLOBAL_KEY` below — is the equivalent for a mutable,
 * growing structure instead of a one-shot value.
 *
 * `GLOBAL_KEY` (exported below) MUST STAY IN SYNC with `crowi-environment.js`'s
 * `RING_BUFFER_GLOBAL_KEY` constant (duplicated there for the same reason
 * `test-mongo-sentinel.js`'s protocol is duplicated across packages — two
 * files in genuinely separate module systems that cannot import one
 * another's constant). `crowi-environment.test.ts` asserts the two literals
 * are equal so a future edit to either one alone fails loudly instead of
 * silently emptying the ring-buffer enrichment (nothing else would catch
 * that drift — `handleTestEvent` would just read `this.global[wrongKey]`,
 * always `undefined`, and enrich every record with an empty ring buffer).
 *
 * Ephemeral-port timeouts (Supertest's own local `http.Server`, `app.listen(0)`)
 * fail BEFORE `fetchFn` — and therefore before this ring buffer — ever sees
 * the request (see `setup.ts`'s `fetchFn` doc comment and the spec's design
 * section "HTTP operation 相関は request 境界の ring buffer"). This module
 * does not attempt to represent that failure directly; `crowi-environment.js`'s
 * `handleTestEvent` infers it from the ABSENCE of a corresponding dispatched
 * op plus the shape of the connection error itself (host:port pattern
 * matching against the resolved Mongo URI to rule out a Mongo-side timeout —
 * AC-3).
 */

export const GLOBAL_KEY = '__crowiOpRingBuffer';
const MAX_ENTRIES = 20;

export interface OpRecord {
  method: string;
  path: string;
  /** Always `true` for an entry pushed by `recordDispatchStart` — a request only ever gets an entry once it reaches `fetchFn`, i.e. once it IS dispatched. See this module's doc comment for the "never dispatched at all" case. */
  dispatched: true;
  /** `null` while in flight, and permanently `null` if `honoApp.fetch` itself threw before producing a `Response` — distinguishable from "never dispatched" only by the presence of this entry at all. */
  httpStatus: number | null;
  /** `expect.getState().currentTestName` at push time — jest-circus's own space-joined ancestor-titles format (`getTestID`), so it lines up with the identity `crowi-environment.js`'s `handleTestEvent` computes independently from the Circus `test` object. `null` if read outside a running test (shouldn't happen in practice — `fetchFn` only ever runs inside `beforeAll`/a test/`afterEach`, all of which have a current test name, except `beforeAll` itself; harmless either way, just means this op won't correlate to a specific test later). */
  testFullName: string | null;
  startedAt: string;
  finishedAt: string | null;
}

type RingBufferGlobal = typeof globalThis & { [GLOBAL_KEY]?: OpRecord[] };

function getBuffer(): OpRecord[] {
  const g = globalThis as RingBufferGlobal;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = [];
  }
  return g[GLOBAL_KEY] as OpRecord[];
}

function currentTestFullName(): string | null {
  try {
    const name = expect.getState().currentTestName;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** Pushes a new in-flight entry and returns it — pass the SAME object to `recordDispatchEnd` once the response (or failure) is known. Bounded to the last `MAX_ENTRIES` — this is a "recent context" window for enrichment, not an exhaustive log. */
export function recordDispatchStart(method: string, requestPath: string): OpRecord {
  const entry: OpRecord = {
    method,
    path: requestPath,
    dispatched: true,
    httpStatus: null,
    testFullName: currentTestFullName(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const buffer = getBuffer();
  buffer.push(entry);
  while (buffer.length > MAX_ENTRIES) buffer.shift();
  return entry;
}

/** Finalizes an entry returned by `recordDispatchStart` — `httpStatus: null` when `honoApp.fetch` itself threw rather than returning a `Response`. */
export function recordDispatchEnd(entry: OpRecord, httpStatus: number | null): void {
  entry.httpStatus = httpStatus;
  entry.finishedAt = new Date().toISOString();
}

/** Pure read of the current buffer contents — used by tests. `crowi-environment.js`'s `handleTestEvent` reads the SAME underlying array via `this.global.__crowiOpRingBuffer` directly (a plain CJS module cannot import this TS module — see this file's doc comment), not through this function. */
export function snapshotRecentOps(): OpRecord[] {
  return getBuffer().slice();
}

/** Test-only: reset between fixtures so one test's entries don't leak into another's expectations. */
export function __resetRingBufferForTests(): void {
  (globalThis as RingBufferGlobal)[GLOBAL_KEY] = [];
}
