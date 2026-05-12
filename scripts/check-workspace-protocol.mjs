#!/usr/bin/env node
// Enforce @crowi/* dep ranges: deps→workspace:^, devDeps→workspace:*, peerDeps→literal semver.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_DIRS = ['apps', 'packages']

/**
 * @typedef {{path: string, key: string, dep: string, value: string, expected: string}} Violation
 */

function collectPackageJsons() {
  /** @type {string[]} */
  const files = []
  for (const dir of WORKSPACE_DIRS) {
    const dirPath = join(ROOT, dir)
    let entries
    try {
      entries = readdirSync(dirPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const pkgPath = join(dirPath, entry, 'package.json')
      try {
        if (statSync(pkgPath).isFile()) files.push(pkgPath)
      } catch {
        // no package.json in this subdir — skip
      }
    }
  }
  return files.sort()
}

/**
 * peerDeps must NOT use `workspace:` (would leak the workspace token into the
 * published manifest). `catalog:` is allowed — pnpm pack rewrites it at publish.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isAcceptablePeerRange(value) {
  return !value.startsWith('workspace:')
}

/**
 * @param {string} pkgPath
 * @returns {Violation[]}
 */
function checkPackage(pkgPath) {
  /** @type {Violation[]} */
  const violations = []
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const rel = relative(ROOT, pkgPath)

  /** @type {Array<[string, (val: string) => string | null]>} */
  const checks = [
    ['dependencies', (val) => (val === 'workspace:^' ? null : 'workspace:^')],
    ['devDependencies', (val) => (val === 'workspace:*' ? null : 'workspace:*')],
    [
      'peerDependencies',
      (val) =>
        isAcceptablePeerRange(val)
          ? null
          : 'a literal semver range (e.g. ^0.1.0) or catalog:',
    ],
  ]

  for (const [key, validate] of checks) {
    const block = pkg[key]
    if (!block || typeof block !== 'object') continue
    for (const [dep, value] of Object.entries(block)) {
      if (!dep.startsWith('@crowi/')) continue
      if (typeof value !== 'string') continue
      const expected = validate(value)
      if (expected !== null) {
        violations.push({ path: rel, key, dep, value, expected })
      }
    }
  }
  return violations
}

function main() {
  const pkgFiles = collectPackageJsons()
  /** @type {Violation[]} */
  const all = []
  for (const pkgPath of pkgFiles) {
    all.push(...checkPackage(pkgPath))
  }

  if (all.length === 0) {
    console.log(
      `workspace-protocol check: OK (${pkgFiles.length} package.json files scanned)`,
    )
    process.exit(0)
  }

  console.error(`workspace-protocol check: ${all.length} violation(s) found:\n`)
  for (const v of all) {
    console.error(
      `  ${v.path}: ${v.key}["${v.dep}"] = ${JSON.stringify(v.value)} (expected ${v.expected})`,
    )
  }
  console.error(
    '\nRules:\n' +
      '  dependencies."@crowi/*"     → must be "workspace:^"\n' +
      '  devDependencies."@crowi/*"  → must be "workspace:*"\n' +
      '  peerDependencies."@crowi/*" → must be a literal semver range (no workspace:)',
  )
  process.exit(1)
}

main()
