// Cross-process worker fixture for
// packages/web/scripts/paraglide-compile.test.mjs's AC1(a) real-OS-process
// concurrency test. Deliberately named so it does NOT match the
// `*.test.mjs` glob `pnpm test:scripts` runs — it never runs as its own
// suite, it only exists to be `node`-spawned as an independent OS process by
// that test, exercising the wrapper's O_EXCL lock across real process
// boundaries (not just concurrent in-process `Promise`s, which the suite
// also still covers separately since that variant is cheap and documents
// the lock's in-process behavior too).
//
// Usage: `node paraglide-compile.crossprocess-worker.mjs <webDir>`. Prints
// the `runWrapper` result as JSON on stdout and exits 0 on success, or
// prints the error and exits 1 on failure. Uses the shared `fakeCompile`
// fixture (see ./paraglide-compile.test-fixtures.mjs) instead of shelling
// out to the real (network-fetching) paraglide-js CLI, so this worker never
// needs network access either — with an artificial delay so a real overlap
// between two concurrently-spawned workers would be caught by the parent
// test's polling observer.

import { runWrapper } from './paraglide-compile.mjs'
import { fakeCompile } from './paraglide-compile.test-fixtures.mjs'

const webDir = process.argv[2]
if (!webDir) {
  process.stderr.write('paraglide-compile.crossprocess-worker: missing <webDir> argument\n')
  process.exitCode = 1
} else {
  // `log` defaults to stdout inside runWrapper, which would otherwise mix a
  // human-readable progress line into the same stream this worker uses for
  // its machine-readable JSON result — route it to stderr instead so stdout
  // carries nothing but the final `JSON.stringify(result)` the parent test
  // parses.
  runWrapper({
    webDir,
    compileFn: (args) => fakeCompile(args, { delayMs: 20 }),
    retries: 50,
    retryDelayMs: 10,
    log: (message) => process.stderr.write(`${message}\n`),
  })
    .then((result) => {
      process.stdout.write(JSON.stringify(result))
      process.exitCode = 0
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
      process.exitCode = 1
    })
}
