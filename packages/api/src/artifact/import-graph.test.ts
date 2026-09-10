/**
 * feature-html-artifact-delivery-policy §AC-DP-8 — production import
 * boundary. `csp.ts` / `policy.ts` / `config.ts` must never reach
 * `./ingest` (parse5 / PostCSS / es-module-lexer) — `models/config.ts`
 * imports `./config` on every process's `setupModels()`, so pulling the
 * parser chain in there would make every process (server, CLI, every test
 * file) pay parse5/PostCSS's load cost just to read a config default.
 *
 * `jest.mock('./ingest', ...)` is hoisted above every `require` below, so
 * this file never loads the real `ingest.ts` — if `csp.ts` / `policy.ts` /
 * `config.ts` transitively required it, the mock factory's `throw` would
 * surface as a require-time error instead of silently succeeding.
 *
 * `csp.test.ts` builds its fixtures from the REAL `ingestHtmlArtifact`, so
 * it cannot share this mock — this is a dedicated file for exactly that
 * reason.
 */
jest.mock('./ingest', () => {
  throw new Error('ingest must not be loaded');
});

describe('artifact production import graph', () => {
  // `require(...)` (not a static `import`) is deliberate: a static import
  // would evaluate at module-load time, before any `it()` runs, so a throw
  // (the exact failure this test exists to catch) would fail the whole file
  // to load rather than being caught by `expect(...).not.toThrow()`.
  it('./config does not reach ./ingest', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(() => require('./config')).not.toThrow();
  });

  it('./policy does not reach ./ingest', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(() => require('./policy')).not.toThrow();
  });

  it('./csp does not reach ./ingest', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(() => require('./csp')).not.toThrow();
  });
});
