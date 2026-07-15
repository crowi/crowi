/**
 * Standalone `fork()`ed worker used only by
 * `network-boundary.esm-preimport.test.ts` to prove that
 * `installDenyByDefaultNetworkBoundary()`'s `syncBuiltinESMExports()` call
 * (spec §10, see `network-boundary.ts`'s header comment) closes the gap
 * codex round 1 flagged: a CJS `require()`-based monkeypatch of a
 * builtin's `module.exports` does not, by itself, propagate to a
 * *different* module's genuine ESM `import { x } from 'node:...'` binding
 * that was already resolved BEFORE the boundary installs — Node's builtin
 * ESM facade snapshots CJS exports into separate binding cells rather than
 * reading `module.exports` live on every access.
 *
 * **Why `dns.lookup`, specifically** (empirically verified while building
 * this fixture, see the session's scratch investigation): `net.connect` /
 * `http.request` / `https.request` / `tls.connect` all internally end up
 * calling `net.Socket.prototype.connect` (or `net.createConnection`) to
 * actually open the socket, and `denyNodeNetModule()` patches that shared
 * PROTOTYPE method directly — a prototype mutation is visible through
 * *any* reference to the constructor, ESM-stale or not, since it's the
 * same object either way. That accidental defense-in-depth means those
 * four vectors are blocked even via a pre-imported ESM binding regardless
 * of whether `syncBuiltinESMExports()` runs, which would make a test built
 * on them pass for the wrong reason (indistinguishable from a regression
 * that silently drops the `syncBuiltinESMExports()` call). `dns.lookup` has
 * no such fallback — it's a standalone leaf binding to a native binding
 * with nothing else in this module's patch set underneath it — so it is
 * the one vector that genuinely discriminates "the sync call is present
 * and working" from "the sync call regressed away".
 *
 * This mirrors the real hazard in `render-worker.ts`'s import order: its
 * `dom-env.ts` (imported before `network-boundary.ts`) pulls in `jsdom`,
 * whose own dependency graph may hold ESM-level references to Node
 * builtins established before the boundary ever runs. Rather than depend
 * on jsdom's internals (an implementation detail this package doesn't
 * control and that could change upstream), this fixture reproduces the
 * hazard directly and deterministically: it performs its OWN genuine ESM
 * named import of `node:dns` at module-evaluation time (guaranteed to run
 * before the `process.on('message', ...)` handler below is even
 * registered) — standing in for "some module deep in the dependency graph
 * already captured this binding" — and only THEN installs the boundary,
 * exactly as `render-worker.ts` does relative to `dom-env.ts`.
 *
 * Runs as ESM for the same reason `render-worker.ts` and Phase 0's
 * `spike-worker.ts` do: plain `.ts` top-level `import`/`export` syntax with
 * no `package.json: "type"` declared gets Node's native TypeScript support
 * to reparse it as ESM.
 */

// Genuine ESM named import, resolved before this module's own body runs —
// the exact "already-evaluated ESM import" scenario under test. Explicit
// `.ts` extension on the relative import for Node's native ESM resolver
// (same convention as `render-worker.ts`).
import { lookup as preImportedDnsLookup } from 'node:dns';
import { installDenyByDefaultNetworkBoundary } from '../network-boundary.ts';

interface ProbeRequestMessage {
  type: 'probe';
}

interface ProbeResultMessage {
  type: 'probe-result';
  /** true only if `dns.lookup`'s callback received an Error matching the boundary's own `deny-by-default` wording, never a real DNS result/error. */
  dnsLookupBlocked: boolean;
}

// Import order matters (mirrors `render-worker.ts`'s `main()`): the ESM
// import above already ran by the time this line executes, so installing
// the boundary here is strictly AFTER that binding was captured — without
// `syncBuiltinESMExports()`, `preImportedDnsLookup` below would still
// resolve to the ORIGINAL, unpatched function and perform a real DNS query.
installDenyByDefaultNetworkBoundary();

process.on('message', (msg: ProbeRequestMessage) => {
  if (msg.type !== 'probe') return;

  preImportedDnsLookup('example.invalid', (err) => {
    const dnsLookupBlocked = err instanceof Error && /deny-by-default/.test(err.message);
    process.send?.({ type: 'probe-result', dnsLookupBlocked } satisfies ProbeResultMessage);
  });
});

process.send?.({ type: 'ready' });
