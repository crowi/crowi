/**
 * Production deny-by-default network boundary for the Mermaid render
 * worker (spec §10 "production の deny-by-default 境界"). Installed by
 * `render-worker.ts` immediately after the hardened DOM env and BEFORE
 * `mermaid` is loaded at all.
 *
 * This is a DIFFERENT artifact from Phase 0's
 * `__fixtures__/network-instrumentation.ts` — that file exists to prove
 * (inside a throwaway spike test) that a monkey-patch CAN observe every
 * outbound-reach vector a candidate library might use. This file is the
 * production graduation of the same chokepoint technique: instead of
 * *recording* an attempt and then blocking it, it just blocks it (no
 * recording — a running worker has no test harness listening).
 *
 * Mechanism choice for `node:net`/`http`/`https`/`dns`/`tls` (spec §10
 * gives an explicit choice between a `module.register()` ESM loader hook
 * and "worker起動時のrequire/importの巻き取り" — this implements the
 * latter): rather than blocking the `require`/`import` of these modules
 * outright, every one of them is reachable via plain CJS `require()`
 * (they're Node core builtins, not the ESM-only leaves `jsdom`/`mermaid`
 * have), so `createRequire` gets a live reference to each module's
 * mutable `module.exports` object and patches the actual connection
 * *entry points* on it — `net.connect` / `net.createConnection` /
 * `net.Socket.prototype.connect` / `http.request` / `http.get` /
 * `https.request` / `https.get` / `tls.connect` / `dns.lookup` /
 * `dns.resolve*`. This is the same chokepoint Phase 0's spike
 * instrumentation validated end-to-end against a real `mermaid` render
 * (`__fixtures__/network-instrumentation.ts`'s doc comment), and it is
 * strictly stronger than blocking only the module *reference*: every
 * consumer of these modules (Node core builtins included) shares the
 * same singleton `module.exports` object, so the patch applies
 * regardless of how — or from how deep in the dependency tree — the
 * module was obtained. `fetch` / `XMLHttpRequest` / `WebSocket` /
 * `EventSource` are deleted/stubbed directly as globals (§10 (b)).
 *
 * **Residual risk (documented per spec §10)**: this boundary is JS-land
 * only. It depends on Mermaid and its resolved dependency tree being
 * pure JS (confirmed by Phase 0 gate D's native-addon audit) — a native
 * addon could call the OS socket API directly, bypassing every hook
 * here. OS/container-level egress control is a documented operational
 * recommendation, not a requirement this module can enforce.
 *
 * **ESM named-import staleness — why `syncBuiltinESMExports()` is
 * required, not optional**: patching a builtin's CJS `module.exports`
 * object (above) is visible to every OTHER CJS `require()` of that same
 * module, because they all share the identical `module.exports` object
 * reference. It is NOT automatically visible to code that obtained the
 * builtin via a genuine ESM `import { connect } from 'node:net'` —
 * Node's synthetic ESM facade for builtins snapshots the CJS exports
 * into separate binding cells rather than reading `module.exports` live
 * on every access, so an ESM import resolved *before* this module runs
 * (e.g. something deep in `jsdom`'s or `mermaid`'s own dependency graph,
 * evaluated as part of `render-worker.ts`'s import graph before `main()`
 * calls `installDenyByDefaultNetworkBoundary()`) would otherwise keep
 * using the ORIGINAL, unpatched function forever — confirmed
 * empirically (see `network-boundary.esm-preimport.test.ts`, forked as
 * a real ESM child process precisely because this staleness is invisible
 * to ts-jest's CJS-transpiled unit tests, which turn every `import`
 * back into a `require()` and can never observe it). `node:module`'s
 * `syncBuiltinESMExports()` exists for exactly this scenario — it
 * re-syncs every already-resolved builtin ESM binding in the process to
 * the builtin's CURRENT `module.exports` values — so calling it once,
 * after all the CJS-level patches above, closes this gap for every ESM
 * importer in the process, regardless of import order.
 */

import { createRequire, syncBuiltinESMExports } from 'node:module';

// A synthetic, non-existent base path rather than `__filename` /
// `import.meta.url` — this file is loaded in two different module
// systems (plain CJS under ts-jest's test transform, genuine ESM when
// pulled into `render-worker.ts`'s module graph at `fork()` time,
// neither of which reliably provides both `__filename` and
// `import.meta` at once) and only ever resolves Node core builtins
// below, whose resolution never touches the filesystem or depends on
// the base path's real existence — confirmed empirically
// (`createRequire('/anything.js')('node:net')` resolves fine).
const nodeRequire = createRequire('/crowi-plugin-renderer-mermaid-network-boundary.js');

const DENIED_GLOBAL_APIS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;

let installed = false;
/** Undo thunks captured at install time, run in reverse by the test-only uninstall helper. */
let restoreFns: Array<() => void> = [];

/** Idempotent — safe to call once at worker startup. */
export function installDenyByDefaultNetworkBoundary(): void {
  if (installed) return;
  installed = true;

  denyGlobalNetworkApis();
  denyNodeNetModule();
  denyNodeHttpModules();
  denyNodeDnsModule();
  denyNodeTlsModule();

  // Must run AFTER every CJS-level patch above and BEFORE `mermaid` is
  // imported (see `render-worker.ts`'s call-order comment) — closes the
  // ESM named-import staleness gap documented in this module's header
  // comment. A no-op (cheap) if nothing in the process ever imported
  // these builtins via genuine ESM `import` in the first place.
  syncBuiltinESMExports();
}

/** Shared wording for every denied-API error, thrown or rejected (`throwingStub` / `dnsCallbackBlocked` / `dnsPromiseBlocked`). */
function deniedMessage(label: string): string {
  return `[render-worker] ${label} is disabled — the Mermaid render worker's deny-by-default network boundary blocks all outbound I/O`;
}

/**
 * A `function` declaration (not an arrow function) so the stub also
 * throws the same descriptive error when called via `new` — several of
 * the denied globals (`XMLHttpRequest`, `WebSocket`, `EventSource`) are
 * normally constructors, and an arrow function used with `new` would
 * throw a generic (less useful) "is not a constructor" `TypeError`
 * instead of this module's own message.
 */
function throwingStub(name: string): (...args: unknown[]) => never {
  return function stub(..._args: unknown[]): never {
    throw new Error(deniedMessage(`'${name}'`));
  };
}

function denyGlobalNetworkApis(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of DENIED_GLOBAL_APIS) {
    const stub = throwingStub(name);
    const hadOwn = Object.prototype.hasOwnProperty.call(g, name);
    const original = g[name];
    try {
      Object.defineProperty(globalThis, name, { value: stub, configurable: true, writable: true });
      restoreFns.push(() => {
        if (hadOwn) Object.defineProperty(globalThis, name, { value: original, configurable: true, writable: true });
        else delete g[name];
      });
    } catch {
      // A handful of jsdom-defined globals are non-configurable getters;
      // best-effort — the module-level require() patches below are the
      // primary boundary for anything that would slip past this.
    }
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
    if (win) {
      const winHadOwn = Object.prototype.hasOwnProperty.call(win, name);
      const winOriginal = win[name];
      try {
        win[name] = stub;
        restoreFns.push(() => {
          if (winHadOwn) win[name] = winOriginal;
          else delete win[name];
        });
      } catch {
        // same best-effort rationale as above.
      }
    }
  }
}

interface NetModule {
  connect: (...args: unknown[]) => unknown;
  createConnection: (...args: unknown[]) => unknown;
  Socket: { prototype: { connect: (...args: unknown[]) => unknown } };
}

function denyNodeNetModule(): void {
  const net = nodeRequire('node:net') as NetModule;
  const originals = { connect: net.connect, createConnection: net.createConnection, socketConnect: net.Socket.prototype.connect };
  net.connect = throwingStub('net.connect');
  net.createConnection = throwingStub('net.createConnection');
  net.Socket.prototype.connect = throwingStub('net.Socket#connect');
  restoreFns.push(() => {
    net.connect = originals.connect;
    net.createConnection = originals.createConnection;
    net.Socket.prototype.connect = originals.socketConnect;
  });
}

interface HttpLikeModule {
  request: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
}

function denyNodeHttpModules(): void {
  const http = nodeRequire('node:http') as HttpLikeModule;
  const httpOriginals = { request: http.request, get: http.get };
  http.request = throwingStub('http.request');
  http.get = throwingStub('http.get');
  const https = nodeRequire('node:https') as HttpLikeModule;
  const httpsOriginals = { request: https.request, get: https.get };
  https.request = throwingStub('https.request');
  https.get = throwingStub('https.get');
  restoreFns.push(() => {
    http.request = httpOriginals.request;
    http.get = httpOriginals.get;
    https.request = httpsOriginals.request;
    https.get = httpsOriginals.get;
  });
}

/**
 * Every `node:dns` method that can actually reach the network (resolves a
 * hostname/address over the wire, or looks up a service). Deliberately
 * excludes pure-local config accessors (`getServers`/`setServers`/
 * `getDefaultResultOrder`/`setDefaultResultOrder`) and the `Resolver`
 * constructors themselves — only *calling* a resolve method performs I/O.
 * `dns.Resolver.prototype`, `dns.promises.Resolver.prototype`, and
 * `dns.promises` each carry their OWN (non-inherited) copies of a subset
 * of these same method names — four independent objects, none of which
 * delegate to the callback-style `dns.*` functions patched below, so all
 * four must be patched separately (this is exactly what round-3 review
 * caught missing: `dns.promises.*` and `resolveAny` were reachable even
 * though the callback-style `dns.lookup`/`resolve`/`resolve4`/`resolve6`/
 * `resolveCname` were blocked).
 */
const DNS_NETWORK_METHOD_NAMES = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
] as const;

interface DnsModule {
  Resolver: { prototype: Record<string, unknown> };
  promises: Record<string, unknown> & { Resolver: { prototype: Record<string, unknown> } };
  [methodName: string]: unknown;
}

function dnsCallbackBlocked(label: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const err = new Error(deniedMessage(label));
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      (cb as (err: Error) => void)(err);
      return;
    }
    throw err;
  };
}

function dnsPromiseBlocked(label: string): (...args: unknown[]) => Promise<never> {
  return () => Promise.reject(new Error(deniedMessage(label)));
}

/**
 * Patches every name in `DNS_NETWORK_METHOD_NAMES` that is actually
 * present as a function on `target` (each of the 4 objects below only
 * carries a subset — e.g. `Resolver.prototype` has no `lookup`), queuing
 * the exact original back onto `restoreFns` for the test-only reset.
 */
function patchDnsMethodSet(target: Record<string, unknown>, labelPrefix: string, style: 'callback' | 'promise'): void {
  const originals: Record<string, unknown> = {};
  for (const name of DNS_NETWORK_METHOD_NAMES) {
    if (typeof target[name] !== 'function') continue;
    originals[name] = target[name];
    target[name] = style === 'callback' ? dnsCallbackBlocked(`${labelPrefix}${name}`) : dnsPromiseBlocked(`${labelPrefix}${name}`);
  }
  restoreFns.push(() => {
    for (const name of Object.keys(originals)) target[name] = originals[name];
  });
}

function denyNodeDnsModule(): void {
  const dns = nodeRequire('node:dns') as DnsModule;
  // `require('node:dns/promises') === require('node:dns').promises`
  // (confirmed empirically) so patching `dns.promises` in place also
  // covers every consumer that imports the `node:dns/promises` module
  // specifier directly.
  patchDnsMethodSet(dns, 'dns.', 'callback');
  patchDnsMethodSet(dns.Resolver.prototype, 'dns.Resolver#', 'callback');
  patchDnsMethodSet(dns.promises, 'dns.promises.', 'promise');
  patchDnsMethodSet(dns.promises.Resolver.prototype, 'dns.promises.Resolver#', 'promise');
}

interface TlsModule {
  connect: (...args: unknown[]) => unknown;
}

function denyNodeTlsModule(): void {
  const tls = nodeRequire('node:tls') as TlsModule;
  const original = tls.connect;
  tls.connect = throwingStub('tls.connect');
  restoreFns.push(() => {
    tls.connect = original;
  });
}

/**
 * Test-only: fully undo every patch (restoring the exact prior values,
 * including "was never own-set" for the globals) and clear the
 * `installed` guard so a subsequent `installDenyByDefaultNetworkBoundary()`
 * re-applies from a clean slate. Production `render-worker.ts` never
 * calls this — the boundary is meant to be permanent for the life of
 * the worker process. Exists so this module's own test suite (and any
 * other test file that happens to share a Jest worker process) is never
 * left with a permanently-patched `net`/`http`/`dns`/`tls`.
 */
export function _resetDenyByDefaultNetworkBoundaryForTest(): void {
  for (const restore of restoreFns.reverse()) restore();
  restoreFns = [];
  installed = false;
  // Mirrors the `syncBuiltinESMExports()` call in `install...` — restores
  // any ESM-side bindings this same process resynced away from their
  // original values back to the (now-restored) CJS exports.
  syncBuiltinESMExports();
}
