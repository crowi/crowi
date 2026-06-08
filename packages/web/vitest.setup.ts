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
