#!/usr/bin/env node
// Compute the next Crowi DISTRIBUTION version (the umbrella product version),
// independent of any single npm package version. RFC: feature-ci-release-automation D3.
//
// Why a separate "distribution version" exists (D3):
//   The Docker full/slim image bundles ALL @crowi/* packages. A plugin-only
//   patch (e.g. a dependency security bump) changes the image even when
//   @crowi/api / web / api-contract do NOT bump. If we reused a single npm
//   version as the Docker tag, that release would either reuse an existing
//   immutable tag (content changed under a fixed tag — forbidden) or force an
//   empty bump of api/web. So the distribution version MUST increment on every
//   release regardless of which npm packages moved.
//
// Numbering (D3, candidate (i) — "max existing git tag + 1"):
//   - base   = major.minor + prerelease CHANNEL of the published linked
//              product version (e.g. @crowi/api = 2.0.0-alpha.1 → base
//              `2.0.0-alpha`). The base follows the changesets pre channel:
//              alpha → beta → stable flips automatically when the linked base
//              changes (changeset `pre exit` / `pre enter beta`).
//   - counter = (max existing git tag `v<base>.<n>`) + 1, or 0 if none.
//   → distribution version = `<base>.<counter>` ; git tag = `v<base>.<counter>`.
//
//   This is idempotent and auditable (no extra state to maintain), always
//   advances by +1 even for plugin-only patches, and tracks the existing real
//   tag history (v2.0.0-alpha.0 / v2.0.0-alpha.1 → next v2.0.0-alpha.2).
//
//   Stable example: linked product version 2.0.0 → base `2.0.0` → tag
//   `v2.0.0.0`, `v2.0.0.1`, … (the 4th segment is the distribution counter).
//
// Usage:
//   node scripts/compute-dist-version.mjs
//     # base read from packages/api/package.json (the published linked version),
//     # existing tags read from `git tag --list 'v<base>.*'`.
//
//   node scripts/compute-dist-version.mjs --base 2.0.0-alpha --tags v2.0.0-alpha.0,v2.0.0-alpha.1
//     # fixture mode for local verification: pass base + comma-separated tag
//     # list explicitly (no git / no package.json read). Either flag may be
//     # given on its own.
//
// Output (stdout): a single line `v<dist-version>` (e.g. `v2.0.0-alpha.2`).
// For GitHub Actions, also appends `dist-version=<v...>` to $GITHUB_OUTPUT and
// writes the value to the file named by --out (if given).

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// SINGLE SOURCE OF TRUTH for version/channel parsing (D3). baseFromVersion is
// shared with build-images.mjs + docker.yml so the rule cannot drift.
import { baseFromVersion } from './release-tags.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const getOpt = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// --- counter: max existing distribution counter for this base, +1 ---
// Tags look like `v<base>.<counter>` where <counter> is a non-negative integer.
// We escape the base for the regexp (it contains `.` and `-`).
const counterFromTags = (base, tags) => {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^v${escaped}\\.(\\d+)$`)
  let max = -1
  for (const tag of tags) {
    const m = re.exec(tag.trim())
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n > max) max = n
    }
  }
  return max + 1
}

const readBaseFromPackage = () => {
  const pkgPath = path.join(repoRoot, 'packages', 'api', 'package.json')
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return baseFromVersion(version)
}

const readTagsFromGit = (base) => {
  const out = execFileSync('git', ['tag', '--list', `v${base}.*`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return out.split('\n').filter(Boolean)
}

// --- resolve inputs (fixture flags override git / package.json) ---
const baseArg = getOpt('--base', null)
const tagsArg = getOpt('--tags', null)

const base = baseArg !== null ? baseFromVersion(baseArg) : readBaseFromPackage()
const tags =
  tagsArg !== null
    ? tagsArg.split(',').map((t) => t.trim()).filter(Boolean)
    : readTagsFromGit(base)

const counter = counterFromTags(base, tags)
const distVersion = `v${base}.${counter}`

process.stdout.write(`${distVersion}\n`)

// GitHub Actions step output + optional artifact file.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `dist-version=${distVersion}\n`)
}
const outFile = getOpt('--out', null)
if (outFile) {
  writeFileSync(outFile, `${distVersion}\n`)
}
