// Shared fixture compiler for paraglide-compile.mjs's own test suite.
// Used by both paraglide-compile.test.mjs (in-process + spawned-worker
// concurrency variants) and paraglide-compile.crossprocess-worker.mjs (the
// real-OS-process worker that suite spawns) — kept here once instead of
// copy-pasted so the two variants can never drift out of sync with each
// other.

import fs from 'node:fs'
import path from 'node:path'

/**
 * Stands in for the real `paraglide-js compile` CLI: reads the fixture's
 * baseLocale messages and writes a staging tree with the same shape the real
 * compiler produces (entry files, `messages/_index.js`, one leaf per message
 * key named `<key with . replaced by _>.js`) — verified against a real
 * `paraglide-js compile` run of the actual packages/web project while
 * implementing the wrapper. Deterministic: identical inputs always produce
 * byte-identical output, and only a changed message's own leaf file differs
 * when one translation changes (entry files / `_index.js` only depend on the
 * key set, not values).
 * @param {{ webDir: string, stagingDir: string }} args
 * @param {{ delayMs?: number }} [opts] artificial delay before writing, so a
 *   real overlap between two concurrently-spawned processes is wide enough
 *   for a parent test's polling observer to catch.
 */
export async function fakeCompile({ webDir, stagingDir }, { delayMs = 0 } = {}) {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  const settings = JSON.parse(fs.readFileSync(path.join(webDir, 'project.inlang', 'settings.json'), 'utf8'))
  const baseMessages = JSON.parse(fs.readFileSync(path.join(webDir, 'messages', `${settings.baseLocale}.json`), 'utf8'))
  const keys = Object.keys(baseMessages).filter((key) => key !== '$schema')

  fs.mkdirSync(path.join(stagingDir, 'messages'), { recursive: true })
  for (const name of ['runtime.js', 'server.js', 'messages.js', 'registry.js', 'README.md', '.gitignore', '.prettierignore']) {
    fs.writeFileSync(path.join(stagingDir, name), `/* fixture ${name} */\n`)
  }
  const indexBody = keys.map((key) => `export * from './${key.replace(/\./g, '_')}.js'\n`).join('')
  fs.writeFileSync(path.join(stagingDir, 'messages', '_index.js'), indexBody)
  for (const key of keys) {
    const leaf = `${key.replace(/\./g, '_')}.js`
    fs.writeFileSync(path.join(stagingDir, 'messages', leaf), `export const value = ${JSON.stringify(baseMessages[key])}\n`)
  }
}
