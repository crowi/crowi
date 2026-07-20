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
// prints the error and exits 1 on failure. Uses a fixture `compileFn`
// instead of shelling out to the real (network-fetching) paraglide-js CLI,
// so this worker never needs network access either — same rationale as the
// in-process `fakeCompile` in the test file.

import fs from 'node:fs'
import path from 'node:path'

import { runWrapper, sleep } from './paraglide-compile.mjs'

/**
 * Same fixture-compiler shape as `fakeCompile` in `paraglide-compile.test.mjs`
 * (kept in sync by hand — both are tiny and dependency-free on purpose), with
 * an artificial delay so a real overlap between two concurrently-spawned
 * workers would be caught by the parent test's polling observer.
 * @param {{ webDir: string, stagingDir: string }} args
 */
async function slowFakeCompile({ webDir, stagingDir }) {
  await sleep(20)
  const settings = JSON.parse(fs.readFileSync(path.join(webDir, 'project.inlang', 'settings.json'), 'utf8'))
  const baseMessages = JSON.parse(fs.readFileSync(path.join(webDir, 'messages', `${settings.baseLocale}.json`), 'utf8'))
  const keys = Object.keys(baseMessages).filter((key) => key !== '$schema')

  fs.mkdirSync(path.join(stagingDir, 'messages'), { recursive: true })
  for (const name of ['runtime.js', 'server.js', 'messages.js', 'registry.js', 'README.md']) {
    fs.writeFileSync(path.join(stagingDir, name), `/* fixture ${name} */\n`)
  }
  const indexBody = keys.map((key) => `export * from './${key.replace(/\./g, '_')}.js'\n`).join('')
  fs.writeFileSync(path.join(stagingDir, 'messages', '_index.js'), indexBody)
  for (const key of keys) {
    const leaf = `${key.replace(/\./g, '_')}.js`
    fs.writeFileSync(path.join(stagingDir, 'messages', leaf), `export const value = ${JSON.stringify(baseMessages[key])}\n`)
  }
}

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
  runWrapper({ webDir, compileFn: slowFakeCompile, retries: 50, retryDelayMs: 10, log: (message) => process.stderr.write(`${message}\n`) })
    .then((result) => {
      process.stdout.write(JSON.stringify(result))
      process.exitCode = 0
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
      process.exitCode = 1
    })
}
