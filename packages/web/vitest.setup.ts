// Global Vitest setup, registered via `test.setupFiles` in vitest.config.ts.
//
// This file is preventive hardening (the web suite is currently green): it
// gives every test the same baseline so future tests can't reintroduce the
// flake classes seen on the API side — leaked DOM between cases, jsdom gaps
// that only some files happen to stub, and the navigation noise jsdom prints
// on un-prevented anchor clicks.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

// React 19 prints "The current testing environment is not configured to
// support act(...)" on EVERY act-driven update unless this global flag is
// set. Tests that call React's own `act` (imported from 'react', not the
// RTL re-export) don't get the flag set for them, so a single
// event-dispatch test floods the output with hundreds of identical lines.
// Setting it true here (the documented Vitest + React Testing Library setup)
// configures the act environment once for the whole suite, so explicit
// `act(...)` calls actually flush updates instead of warning. The residual
// "not wrapped in act" noise it surfaces is handled by the console filter
// below.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Filter React's act() warnings out of the console.
//
// With the act environment on (above), React emits "An update to X inside a
// test was not wrapped in act(...)" whenever an async state update settles
// after a test's synchronous body. In this suite those come from benign
// trailing updates — a Radix dialog closing its `openId` async, a hook's
// saving-flag settling — that NO assertion depends on. They:
//   - never correlate with a failure (a genuinely broken async test asserts
//     the wrong value and FAILS; it does not merely warn),
//   - fire intermittently (timing-dependent), and
//   - are misattributed by vitest to whatever test happens to be running when
//     the microtask fires, not the one that caused them,
// so they are noise that floods the output without being actionable. Fixing
// each at the source (await act / waitFor) is worthwhile where cheap — done
// for use-collab-save — but chasing the misattributed long tail across every
// dialog/provider test does not converge. Suppress ONLY this warning family;
// every other console.error (including real React errors) still surfaces, and
// a broken async test still fails loudly via its assertion.
const REACT_ACT_NOISE = ['not wrapped in act', 'not configured to support act'];
const originalConsoleError = console.error.bind(console);
console.error = (...args: Parameters<typeof console.error>) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (REACT_ACT_NOISE.some((needle) => first.includes(needle))) {
    return;
  }
  originalConsoleError(...args);
};

// Unmount anything a test rendered so the next test starts from a clean DOM.
// `@testing-library/react`'s cleanup is idempotent, so files that still call
// their own `afterEach(cleanup)` (kept intentionally — removing the per-file
// boilerplate is out of scope) double-call it harmlessly.
afterEach(() => {
  cleanup();
});

// jsdom does not implement `window.matchMedia`. Provide a no-op stub that
// reports "no match" so components reading prefers-color-scheme / responsive
// media queries can be unit-tested without each file rolling its own stub.
beforeAll(() => {
  if (typeof window === 'undefined') {
    return;
  }

  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
  }

  // jsdom can't navigate, so an un-prevented anchor click (or a
  // `window.location` assignment) emits a `jsdomError` —
  // "Not implemented: navigation to another Document" — that the default
  // virtual console forwards to `console.error`. Tests that deliberately
  // exercise a real-navigation anchor (asserting `defaultPrevented === false`)
  // therefore print deterministic noise. Swallow only that one message at the
  // virtual-console boundary; every other jsdomError still propagates.
  //
  // NOTE: this must live here (not in vitest.config.ts's `onConsoleLog`) —
  // Vitest 4 routes jsdom's navigation jsdomError through `_virtualConsole`
  // directly, bypassing the console wrapper `onConsoleLog` intercepts, so a
  // config-level filter does not catch it.
  const virtualConsole = (window as unknown as { _virtualConsole?: VirtualConsoleLike })._virtualConsole;

  if (virtualConsole && !virtualConsole.__crowiNavStubbed) {
    const forwarded = virtualConsole.listeners('jsdomError').slice();
    virtualConsole.removeAllListeners('jsdomError');
    virtualConsole.on('jsdomError', (error: unknown) => {
      const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : '';
      if (message.startsWith('Not implemented: navigation')) {
        return;
      }
      for (const listener of forwarded) {
        listener(error);
      }
    });
    virtualConsole.__crowiNavStubbed = true;
  }
});

type JsdomErrorListener = (error: unknown) => void;

interface VirtualConsoleLike {
  __crowiNavStubbed?: boolean;
  listeners(event: 'jsdomError'): JsdomErrorListener[];
  removeAllListeners(event: 'jsdomError'): void;
  on(event: 'jsdomError', listener: JsdomErrorListener): void;
}

/**
 * jsdom ships no `ResizeObserver`. Components that fit content to their
 * container (the diagram lightbox) construct one during a layout effect, so
 * without this the component throws on mount and the test fails for a reason
 * that has nothing to do with what it asserts.
 *
 * The stub deliberately never fires. jsdom reports every box as 0x0, so a
 * callback would only ever deliver measurements the component is already
 * required to ignore. Tests that need to assert real fitting behaviour belong
 * in the browser-driven suite, not here.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
