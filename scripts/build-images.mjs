#!/usr/bin/env node
// Build the official Crowi Docker images (full + slim) with distribution-aware
// tags. RFC: feature-ci-release-automation D3.
//
// Tagging scheme (A) — like node / postgres official images:
//   - The DEFAULT variant (full) carries NO suffix; the slim variant gets `-slim`.
//   - The image version is the INDEPENDENT Crowi DISTRIBUTION version (D3), NOT
//     any single npm package version. The image bundles ALL @crowi/* packages,
//     so it must get a fresh version on EVERY release — even a plugin-only patch
//     where @crowi/api / web / api-contract do not bump. Reusing @crowi/api's
//     version (the OLD model) would either reuse an immutable tag for changed
//     content or force an empty api/web bump. The distribution version is
//     computed by scripts/compute-dist-version.mjs (max existing
//     `v<base>.*` git tag + 1).
//   - Prerelease versions (e.g. 2.0.0-alpha.2) tag the exact version plus a
//     moving CHANNEL tag (`alpha`); they do NOT move `latest` (a bare
//     `docker pull crowi` must keep meaning "latest stable").
//   - Stable versions tag the exact version plus `latest`.
//
// Tag rules live in scripts/release-tags.mjs (the single source of truth shared
// with compute-dist-version.mjs + .github/workflows/docker.yml), so the rule
// cannot drift across the manual build, the release workflow, and the CI build.
//
// So for distribution version v2.0.0-alpha.2:
//   full → crowi:2.0.0-alpha.2       , crowi:alpha
//   slim → crowi:2.0.0-alpha.2-slim  , crowi:alpha-slim
//
// Usage:
//   node scripts/build-images.mjs                          # build full+slim locally
//   node scripts/build-images.mjs --variant slim           # one variant only
//   node scripts/build-images.mjs --image ghcr.io/crowi/crowi
//   node scripts/build-images.mjs --dist-version v2.0.0-alpha.2  # pin the version
//   node scripts/build-images.mjs --push                   # docker push every tag after build
//   node scripts/build-images.mjs --dry-run                # print the docker commands only
//
// When --dist-version is omitted the version is computed the same way the
// release workflow does, by invoking scripts/compute-dist-version.mjs.

import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVersion, stripV, tagsFor } from './release-tags.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// --- args ---
const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const getOpt = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const dryRun = hasFlag('--dry-run')
const push = hasFlag('--push')
const image = getOpt('--image', 'crowi')
const variant = getOpt('--variant', 'both') // full | slim | both

// --- distribution version → tags ---
// Either pinned via --dist-version, or computed exactly like release.yml does
// (compute-dist-version.mjs: max existing `v<base>.*` git tag + 1).
const computeDistVersion = () => {
  const out = execFileSync('node', [path.join(repoRoot, 'scripts', 'compute-dist-version.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return out.trim()
}
const distVersion = stripV(getOpt('--dist-version', null) ?? computeDistVersion())
const { isPrerelease, channel } = parseVersion(distVersion)

const VARIANTS = {
  full: { buildArgs: [], tags: tagsFor(distVersion, 'full') },
  slim: {
    buildArgs: ['--build-arg', 'RUNNER_APP=@crowi/runner-app-slim', '--build-arg', 'RUNNER_APP_DIR=apps/crowi-runner-slim'],
    tags: tagsFor(distVersion, 'slim'),
  },
}
const selected = variant === 'both' ? ['full', 'slim'] : [variant]
if (!selected.every((v) => VARIANTS[v])) {
  console.error(`build-images: unknown --variant '${variant}' (expected full | slim | both)`)
  process.exit(1)
}

console.log(`build-images: distribution version ${distVersion}${isPrerelease ? ` (prerelease channel '${channel}', latest NOT moved)` : ' (stable)'}`)

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
