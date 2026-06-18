#!/usr/bin/env node
// Emit the self-describing BUNDLE MANIFEST for a Crowi Docker image variant:
// the resolved version of every @crowi/* package that variant bundles. RFC:
// feature-ci-release-automation D3 (self-describing / Backstage-style).
//
// Why: the full/slim images bundle a DIFFERENT set of @crowi/* packages (full =
// all first-party plugins; slim = the MongoDB-only subset). The distribution
// tag (e.g. 2.0.0-alpha.2) alone does not say which @crowi/api / plugin versions
// are inside. We embed that set as an OCI label `org.crowi.bundle` (a JSON
// string) so "what @crowi/api is in alpha.2?" is answerable from the image
// metadata alone (`docker buildx imagetools inspect` / a registry label query).
//
// Resolution: start from the variant's runner-project direct @crowi/*
// dependencies (apps/crowi-runner for full, apps/crowi-runner-slim for slim) and
// walk the transitive @crowi/* workspace closure, reading each workspace
// package's own version from packages/<dir>/package.json. This matches what
// `pnpm deploy --filter <runner-app>` puts into the image's node_modules (the
// runner-app's prod workspace subgraph), without needing a built deploy tree —
// so it runs both locally and in CI before/independent of the docker build.
//
// Usage:
//   node scripts/bundle-manifest.mjs --variant full   # default
//   node scripts/bundle-manifest.mjs --variant slim
//
// Output (stdout): a single line of compact JSON,
//   {"@crowi/api":"2.0.0-alpha.1","@crowi/plugin-...":"0.1.0-alpha.0",...}
// sorted by package name. docker.yml feeds this into the
// `org.crowi.bundle` OCI label value.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const getOpt = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const variant = getOpt('--variant', 'full')
const RUNNER_DIRS = { full: 'apps/crowi-runner', slim: 'apps/crowi-runner-slim' }
const runnerDir = RUNNER_DIRS[variant]
if (!runnerDir) {
  console.error(`bundle-manifest: unknown --variant '${variant}' (expected full | slim)`)
  process.exit(1)
}

// Index every workspace package under packages/ by its npm name → { version,
// crowiDeps }. crowiDeps is the set of @crowi/* names in dependencies (the
// runtime closure we follow; devDependencies are not in the prod image).
const indexWorkspacePackages = () => {
  const byName = new Map()
  const pkgsRoot = path.join(repoRoot, 'packages')
  for (const dir of readdirSync(pkgsRoot)) {
    const pkgJsonPath = path.join(pkgsRoot, dir, 'package.json')
    let json
    try {
      json = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    } catch {
      continue // not a package directory
    }
    if (!json.name) continue
    const crowiDeps = Object.keys(json.dependencies ?? {}).filter((d) => d.startsWith('@crowi/'))
    byName.set(json.name, { version: json.version, crowiDeps })
  }
  return byName
}

const workspace = indexWorkspacePackages()

// Seed = the runner project's direct @crowi/* dependencies for this variant.
const runnerPkg = JSON.parse(readFileSync(path.join(repoRoot, runnerDir, 'package.json'), 'utf8'))
const seeds = Object.keys(runnerPkg.dependencies ?? {}).filter((d) => d.startsWith('@crowi/'))

// Transitive @crowi/* closure (BFS). A package not found in the workspace index
// (e.g. an external @crowi/* — none today) is skipped with a warning to stderr.
const manifest = {}
const queue = [...seeds]
const visited = new Set()
while (queue.length > 0) {
  const name = queue.shift()
  if (visited.has(name)) continue
  visited.add(name)
  const entry = workspace.get(name)
  if (!entry) {
    console.error(`bundle-manifest: WARNING ${name} not found in workspace packages/ — skipped`)
    continue
  }
  manifest[name] = entry.version
  for (const dep of entry.crowiDeps) {
    if (!visited.has(dep)) queue.push(dep)
  }
}

// Sort by package name for a stable, diff-friendly label value.
const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]))
process.stdout.write(`${JSON.stringify(sorted)}\n`)
