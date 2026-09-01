'use strict';

/**
 * Runs the REAL `packages/api/eslint.config.mjs` via ESLint's Node API, in a
 * plain Node child process — deliberately OUTSIDE Jest's sandboxed VM
 * context.
 *
 * ESLint's flat-config loader (`lib/config/config-loader.js`) always
 * dynamically `import()`s the config file, even a `.mjs` it could otherwise
 * `require()`. Jest's default (non-`--experimental-vm-modules`) sandbox
 * rejects any native `import()` call from code Jest doesn't itself
 * transform — eslint's own `node_modules` code is untouched by ts-jest, so
 * `new ESLint({ cwd })` + `lintText()` throws "A dynamic import callback was
 * invoked without --experimental-vm-modules" if driven directly from the
 * jest process. That flag DOES fix it, but only by installing Jest's own
 * vm-module machinery for the WHOLE jest process — which was tried first
 * and rejected: it changed how an unrelated dynamic import elsewhere in
 * this package (`src/hono/index.ts`'s `await import('@scalar/hono-api-
 * reference')`, needed because that package is ESM-only) resolves, and
 * broke it (`docs.test.ts`'s `GET /api/docs` started 500ing). A plain Node
 * process — no Jest, no vm sandbox — needs no flag at all for `import()`,
 * flat config or otherwise. Forking this script from the test file, rather
 * than flagging the whole `jest` invocation, keeps the fix scoped to
 * exactly the one test that needs it.
 */
const { ESLint } = require('eslint');

/** @type {import('eslint').ESLint | undefined} */
let eslint;

process.on('message', (msg) => {
  void handle(msg);
});

async function handle(msg) {
  if (msg.type === 'init') {
    eslint = new ESLint({ cwd: msg.cwd });
    process.send({ type: 'ready', id: msg.id });
    return;
  }
  if (msg.type === 'lint') {
    try {
      if (!eslint) {
        throw new Error('eslint-flat-config-runner: lint requested before init');
      }
      const [result] = await eslint.lintText(msg.code, { filePath: msg.filePath });
      process.send({ type: 'result', id: msg.id, messages: result.messages });
    } catch (err) {
      process.send({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }
}
