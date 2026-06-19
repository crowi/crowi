#!/usr/bin/env node
// Aggregate per-package CHANGELOG.md entries into a single distribution release
// notes markdown — one Crowi GitHub Release page per dist tag (v<dist-version>)
// that lists every @crowi/* package that bumped in this release together with
// its CHANGELOG entry, grouped by category (linked product / SDK / plugins /
// tooling). RFC: feature-ci-release-automation, follow-on to D3.
//
// Why this exists:
//   `changesets/action@v1` creates a GitHub Release per published package
//   (`@crowi/api@2.0.0-alpha.X` / `@crowi/plugin-aws@…` / …). Useful for
//   bisecting a single package, but the operator-facing question is "what is
//   in this Crowi distribution version?" — and a per-package release tree is
//   not that view. This script feeds an aggregate release attached to the
//   distribution tag (`v<dist>`) so the umbrella tag has narrative parity
//   with the manual v2.0.0-alpha.1 release that preceded the automation.
//
// Detection of "which packages bumped this release":
//   For each packages/<pkg>/CHANGELOG.md, walk `<previous-v-tag>..HEAD`. Any
//   CHANGELOG file changed in that range bumped in this release. Packages
//   whose CHANGELOG didn't move are silently skipped — the manual approach
//   the script replaces did the same. First-ever release (no previous v-tag)
//   falls back to "include every CHANGELOG that exists", matching the
//   semantic of a clean-slate first publication.
//
// Output: stdout. Caller pipes to a file and passes that file to
//   `gh release create <dist-tag> --notes-file <file>`.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Category buckets, ordered top → bottom in the release notes. Each entry's
// `match` decides where a package falls; `title` is the section heading. The
// linked-product trio is first because it is the bulk of user-visible change;
// `private:true` packages whose CHANGELOG moved (e.g. `@crowi/web`) still go
// here because they ship to users via the Docker image even if they don't
// reach the npm registry.
const CATEGORIES = [
  { key: 'linked', title: 'Crowi core (linked: api / api-contract / web)', match: (name) => ['@crowi/api', '@crowi/api-contract', '@crowi/web'].includes(name) },
  { key: 'sdk', title: 'Plugin SDK', match: (name) => name === '@crowi/plugin-api' },
  { key: 'plugin', title: 'Plugins', match: (name) => name.startsWith('@crowi/plugin-') && name !== '@crowi/plugin-api' },
  { key: 'tooling', title: 'Tooling (CLI / runner)', match: (name) => ['@crowi/admin-cli', '@crowi/cli', '@crowi/runner'].includes(name) },
  { key: 'other', title: 'Other', match: () => true }, // catch-all
]

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]
  }
  return out
}

function sh(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, shell: '/bin/bash' }).toString()
}

/** Latest `v*` git tag that is NOT the current dist version, or `null` for the first release. */
function previousDistTag(currentTag) {
  // --sort=-v:refname puts highest semver first; refnames matching `v*` only.
  // `tag` may not exist yet (we run BEFORE `git tag` for the current dist
  // version is pushed) — but if it does exist (re-run), exclude it explicitly.
  const all = sh("git tag --list 'v*' --sort=-v:refname")
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const t of all) if (t !== currentTag) return t
  return null
}

/** Paths under packages/ whose CHANGELOG.md changed in <range>. Returns absolute paths. */
function changedChangelogs(range) {
  const out = sh(`git log ${range} --name-only --pretty=format: -- 'packages/*/CHANGELOG.md'`)
  return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))].map((p) =>
    path.resolve(REPO_ROOT, p),
  )
}

/** Every packages/<pkg>/CHANGELOG.md that exists — used as the first-release fallback. */
function allChangelogs() {
  const dirs = fs
    .readdirSync(path.join(REPO_ROOT, 'packages'))
    .map((d) => path.join(REPO_ROOT, 'packages', d, 'CHANGELOG.md'))
    .filter((p) => fs.existsSync(p))
  return dirs
}

/**
 * Read a CHANGELOG.md and return the FIRST `## <version>` section: the version
 * string and its body (everything up to but not including the next `## ` or
 * EOF). Returns `null` when the file has no version section yet — this is
 * what changesets-generated CHANGELOGs look like after `pnpm changeset init`
 * but before any release.
 */
function readLatestChangelogSection(file) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  let i = 0
  // Skip the file header (`# @crowi/foo`) and any blank lines until the first
  // `## <version>`.
  while (i < lines.length && !/^## \S/.test(lines[i])) i++
  if (i === lines.length) return null
  const versionLine = lines[i] // `## 2.0.0-alpha.1`
  const version = versionLine.replace(/^##\s+/, '').trim()
  i++
  const body = []
  while (i < lines.length && !/^## \S/.test(lines[i])) {
    body.push(lines[i])
    i++
  }
  // Trim trailing blank lines so sections concat cleanly.
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  return { version, body: body.join('\n') }
}

/** Read `name` from the sibling package.json of a CHANGELOG. */
function packageNameFor(changelogPath) {
  const pkgJsonPath = path.join(path.dirname(changelogPath), 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return null
  return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).name ?? null
}

function classify(name) {
  for (const cat of CATEGORIES) if (cat.match(name)) return cat.key
  return 'other' // unreachable thanks to the catch-all but kept for clarity
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const distTag = args['dist-version']
  if (!distTag) {
    console.error('aggregate-release-notes: --dist-version <vX.Y.Z-channel.N> is required')
    process.exit(1)
  }

  const prev = previousDistTag(distTag)
  const range = prev ? `${prev}..HEAD` : 'HEAD'
  const candidates = prev ? changedChangelogs(range) : allChangelogs()

  // Group changed packages by category, preserving sort within a category.
  const byCategory = new Map(CATEGORIES.map((c) => [c.key, []]))
  for (const file of candidates) {
    const name = packageNameFor(file)
    if (!name) continue
    const section = readLatestChangelogSection(file)
    if (!section) continue
    const cat = classify(name)
    byCategory.get(cat).push({ name, ...section })
  }
  for (const [, list] of byCategory) list.sort((a, b) => a.name.localeCompare(b.name))

  // Render. The empty header section is on purpose — a human can edit the
  // release after creation to add a narrative paragraph above the auto-list.
  const out = []
  out.push(`# Crowi ${distTag}`)
  out.push('')
  out.push(`Distribution release covering the bundled \`@crowi/*\` package versions below.`)
  if (prev) {
    out.push(`Previous distribution: [\`${prev}\`](https://github.com/crowi/crowi/releases/tag/${prev}).`)
  } else {
    out.push('(First distribution release — no previous tag to diff against.)')
  }
  out.push('')

  let anySection = false
  for (const cat of CATEGORIES) {
    const list = byCategory.get(cat.key)
    if (list.length === 0) continue
    anySection = true
    out.push(`## ${cat.title}`)
    out.push('')
    for (const { name, version, body } of list) {
      out.push(`### \`${name}\` ${version}`)
      out.push('')
      out.push(body || '_(no changeset summary)_')
      out.push('')
    }
  }

  if (!anySection) {
    // Defensive: a release that changed no CHANGELOGs (dependency-only image
    // rebuild) still needs SOME body so the release page is not blank.
    out.push('_No package CHANGELOG entries changed in this distribution. The bundled Docker images may still differ from the previous release (dependency rebuild, ES image refresh, etc.)._')
    out.push('')
  }

  process.stdout.write(out.join('\n'))
}

main()
