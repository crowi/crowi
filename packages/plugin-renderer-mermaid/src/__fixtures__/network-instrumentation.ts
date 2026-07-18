/**
 * §8 B — "no-network verification" instrumentation, installed once at
 * spike-worker.ts startup, *before* `mermaid` is imported (so even
 * network calls made at module-init time, not just at render time, would
 * be caught).
 *
 * Instruments exactly the 5 vectors §8 B names: `Image`, `fetch`,
 * `XMLHttpRequest`, DNS lookup, and socket connect. The last two are
 * patched at the `node:dns` / `node:net` module level (via
 * `createRequire`, so the patch lands on the real mutable CJS
 * `module.exports` object rather than a frozen ESM namespace) rather than
 * at the `node:http`/`node:https` level, because every one of Node's
 * higher-level networking APIs (`fetch`, `http`, `https`, `tls`, ...)
 * ultimately opens a socket through `net.Socket#connect` — instrumenting
 * that one chokepoint (plus the browser-facing `Image`/`fetch`/`XHR`
 * globals mermaid could plausibly call directly) gives broad coverage
 * without needing a hook per HTTP-layer module.
 *
 * Each hook *records* the attempt (for the test to assert on) and then
 * throws/rejects synchronously instead of allowing the call to actually
 * proceed — this spike must never let a test make a real outbound
 * connection, regardless of what the corpus does.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let attempts: string[] = [];

export function getNetworkAttempts(): string[] {
  return [...attempts];
}

export function resetNetworkAttempts(): void {
  attempts = [];
}

function record(vector: string, detail?: string): void {
  attempts.push(detail ? `${vector}: ${detail}` : vector);
}

/**
 * mermaid may read an instrumented global either directly off `globalThis`
 * or via `window.<name>` (jsdom's `window` and `globalThis` are different
 * objects once mermaid-dom-env.ts copies jsdom's own-properties across) —
 * every hook below patches both spots so it is reached regardless of which
 * one the caller uses.
 */
function defineOnGlobalAndWindow(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) win[name] = value;
}

let installedOnce = false;

export function installNetworkInstrumentation(): void {
  if (installedOnce) return;
  installedOnce = true;

  instrumentImage();
  instrumentFetch();
  instrumentXhr();
  instrumentDns();
  instrumentNetConnect();
}

function instrumentImage(): void {
  const win = globalThis as unknown as { Image?: new (...args: unknown[]) => HTMLImageElement };
  if (!win.Image) return;
  // Re-bind to a non-optional local: the `function InstrumentedImage`
  // declaration below is hoisted, so TypeScript does not carry the
  // `if (!win.Image) return` narrowing into its body.
  const RealImage: new (...args: unknown[]) => HTMLImageElement = win.Image;

  // jsdom implements `Image` as a WebIDL "legacy factory function" — a
  // plain function that internally builds (and explicitly returns) an
  // `HTMLImageElement`, not a real ES class. When a base constructor
  // explicitly returns an object, `class Sub extends Base` silently
  // discards the derived instance and yields that returned object
  // instead (a real JS `[[Construct]]` semantic, not a jsdom bug) —
  // `class InstrumentedImage extends RealImage { ... }` was tried first
  // and its overrides were silently never reached for exactly this
  // reason (`new Image() instanceof InstrumentedImage` came back
  // `false`). So instead of subclassing, wrap construction in a plain
  // function and patch the *specific instance* `RealImage` hands back —
  // instance-own properties shadow prototype accessors regardless of how
  // the base constructed the object.
  function InstrumentedImage(...args: unknown[]): HTMLImageElement {
    record('Image#constructor');
    const el = new RealImage(...args) as HTMLImageElement & { decode?: () => Promise<void> };
    Object.defineProperty(el, 'src', {
      configurable: true,
      enumerable: true,
      get(): string {
        return el.getAttribute('src') ?? '';
      },
      set(value: string): void {
        record('Image#src=', value);
        // Deliberately do not forward to the real attribute — never give
        // the underlying jsdom implementation a value that could be
        // resolved into a real load attempt.
      },
    });
    el.decode = (): Promise<void> => {
      record('Image#decode');
      return Promise.reject(new Error('spike instrumentation: Image#decode blocked'));
    };
    return el;
  }

  defineOnGlobalAndWindow('Image', InstrumentedImage);
}

function instrumentFetch(): void {
  const stub = async (...args: unknown[]): Promise<never> => {
    const url = typeof args[0] === 'string' ? args[0] : String(args[0]);
    record('fetch', url);
    throw new Error('spike instrumentation: fetch blocked');
  };
  defineOnGlobalAndWindow('fetch', stub);
}

function instrumentXhr(): void {
  const win = globalThis as unknown as { XMLHttpRequest?: typeof XMLHttpRequest };
  if (!win.XMLHttpRequest) return;

  class InstrumentedXhr extends win.XMLHttpRequest {
    override open(_method: string, url: string | URL): void {
      record('XMLHttpRequest#open', String(url));
      throw new Error('spike instrumentation: XMLHttpRequest#open blocked');
    }
  }

  defineOnGlobalAndWindow('XMLHttpRequest', InstrumentedXhr);
}

interface DnsModule {
  lookup: (...args: unknown[]) => void;
  resolve: (...args: unknown[]) => void;
}

function instrumentDns(): void {
  const dns = require('node:dns') as DnsModule;
  const blocked = (name: string) => {
    return (...args: unknown[]) => {
      const hostname = typeof args[0] === 'string' ? args[0] : undefined;
      record(`dns.${name}`, hostname);
      const cb = args[args.length - 1];
      const err = new Error(`spike instrumentation: dns.${name} blocked`);
      if (typeof cb === 'function') {
        (cb as (err: Error) => void)(err);
        return;
      }
      throw err;
    };
  };
  dns.lookup = blocked('lookup');
  dns.resolve = blocked('resolve');
}

interface NetModule {
  connect: (...args: unknown[]) => unknown;
  createConnection: (...args: unknown[]) => unknown;
  Socket: { prototype: { connect: (...args: unknown[]) => unknown } };
}

function instrumentNetConnect(): void {
  const net = require('node:net') as NetModule;
  const blocked = (name: string) => {
    return (...args: unknown[]) => {
      record(`net.${name}`);
      throw new Error(`spike instrumentation: net.${name} blocked`);
    };
  };
  net.connect = blocked('connect');
  net.createConnection = blocked('createConnection');
  net.Socket.prototype.connect = blocked('Socket#connect');
}
