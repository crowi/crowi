/**
 * This package's `test` script passes `--runInBand`, and the repo's root
 * `test` script runs this package in its own `--concurrency=1` turbo pass
 * after every other package. Both exist for the same reason and must move
 * together.
 *
 * Several suites here fork REAL child processes that each pay a full cold
 * start — jsdom setup, network instrumentation, importing the actual
 * `mermaid` dependency graph, `initialize()` — and one
 * (`render-worker.dist-boot.test.ts`) shells out to real boot/deploy checks.
 * Jest's own suite parallelism multiplied the root script's package
 * parallelism (and `@crowi/api`'s `--maxWorkers=5`), so on a 2-core runner
 * the machine was oversubscribed several times over before this package's
 * children were even counted.
 *
 * Gate C's C-5 asserts the parent event loop keeps ticking during a child
 * render. That assertion is condition-based and sound, but the enclosing
 * Jest timeout also measures OS scheduling latency, so starvation could fail
 * the test without any renderer defect. That happened twice: CI run
 * 29717641489, answered then by raising the timeout, and CI run 31243652466,
 * which timed out again at the raised value. A third increase would only
 * move the same wall-clock threshold, so the fix is to stop competing for
 * the cores instead.
 *
 * Do NOT run this package's tests outside turbo —
 * `render-worker.dist-boot.test.ts` requires the turbo-scheduled builds of
 * its dependencies.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
};
