#!/usr/bin/env node
// Build the official Crowi Docker images (full + slim) with version-aware tags.
//
// Tagging scheme (A) — like node / postgres official images:
//   - The DEFAULT variant (full) carries NO suffix; the slim variant gets `-slim`.
//   - The image version tracks `@crowi/api`'s package version.
//   - Prerelease versions (e.g. 2.0.0-alpha.0) tag the exact version plus a
//     moving CHANNEL tag (`alpha`); they do NOT move `latest` (a bare
//     `docker pull crowi` must keep meaning "latest stable").
//   - Stable versions (e.g. 2.0.0) tag the exact version plus `latest`.
//
// So for 2.0.0-alpha.0:
//   full → crowi:2.0.0-alpha.0       , crowi:alpha
//   slim → crowi:2.0.0-alpha.0-slim  , crowi:alpha-slim
//
// Usage:
//   node scripts/build-images.mjs                          # build full+slim locally
//   node scripts/build-images.mjs --variant slim           # one variant only
//   node scripts/build-images.mjs --image ghcr.io/crowi/crowi
//   node scripts/build-images.mjs --push                   # docker push every tag after build
//   node scripts/build-images.mjs --dry-run                # print the docker commands only

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// --- args ---
const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const getOpt = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const dryRun = hasFlag('--dry-run')
const push = hasFlag('--push')
const image = getOpt('--image', 'crowi')
const variant = getOpt('--variant', 'both') // full | slim | both

// --- version → tags ---
const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'api', 'package.json'), 'utf8'))
const dash = version.indexOf('-')
const isPrerelease = dash !== -1
// channel = the prerelease identifier without the numeric suffix: `alpha.0` → `alpha`.
const channel = isPrerelease ? version.slice(dash + 1).split('.')[0] : null
const movingFull = isPrerelease ? [channel] : ['latest']

// full: no suffix; slim: `-slim` on every tag.
const tagsFor = (suffix) => [
  `${version}${suffix}`,
  ...movingFull.map((t) => `${t}${suffix}`),
]
const fullTags = tagsFor('')
const slimTags = tagsFor('-slim')

const VARIANTS = {
  full: { buildArgs: [], tags: fullTags },
  slim: {
    buildArgs: ['--build-arg', 'RUNNER_APP=@crowi/runner-app-slim', '--build-arg', 'RUNNER_APP_DIR=apps/crowi-runner-slim'],
    tags: slimTags,
  },
}
const selected = variant === 'both' ? ['full', 'slim'] : [variant]
if (!selected.every((v) => VARIANTS[v])) {
  console.error(`build-images: unknown --variant '${variant}' (expected full | slim | both)`)
  process.exit(1)
}

console.log(`build-images: version ${version}${isPrerelease ? ` (prerelease channel '${channel}', latest NOT moved)` : ' (stable)'}`)

const run = (cmd, cmdArgs) => {
  const display = `${cmd} ${cmdArgs.join(' ')}`
  if (dryRun) {
    console.log(`[dry-run] ${display}`)
    return
  }
  console.log(`$ ${display}`)
  const res = spawnSync(cmd, cmdArgs, { cwd: repoRoot, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`build-images: \`${display}\` exited ${res.status ?? res.signal}`)
    process.exit(res.status ?? 1)
  }
}

for (const v of selected) {
  const { buildArgs, tags } = VARIANTS[v]
  const tagArgs = tags.flatMap((t) => ['-t', `${image}:${t}`])
  console.log(`\n# ${v} → ${tags.map((t) => `${image}:${t}`).join(', ')}`)
  run('docker', ['build', '-f', 'packages/api/Dockerfile', ...buildArgs, ...tagArgs, '.'])
  if (push) {
    for (const t of tags) run('docker', ['push', `${image}:${t}`])
  }
}

console.log('\nbuild-images: done.')
