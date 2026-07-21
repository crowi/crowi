#!/usr/bin/env node
// Structural guard: source filenames must be kebab-case across the whole
// monorepo (apps/ + packages/). AI-authored and hand-written files kept
// drifting into PascalCase / lowerCamelCase (`MarkdownEditor.tsx`,
// `tokenAuth.ts`) even though Crowi 2.0 uses kebab-case; the prose rule
// alone did not hold, so this makes it mechanical — the same approach as
// check-todo-brevity / check-workspace-protocol.
//
// The rule is deliberately simple:
//   - Only the first dot-delimited segment is checked, so compound suffixes
//     (`foo.test.ts`, `next.config.ts`, `x.smoke.test.ts`) work naturally.
//   - An intentional `_` private/partial marker is allowed, but the name
//     after it must still be kebab-case (`_pager.ts`, `_mdast-walk.ts`).
//   - Directory names are not checked: Next.js uses `[slug]`, `(auth)`, and
//     `%5F…` folder syntax.

import { readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_DIRS = ['apps', 'packages']
const SOURCE_EXT = /\.(ts|tsx)$/
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'generated',
  'paraglide',
  '.paraglide-meta',
])

/**
 * @param {string} filename
 * @returns {string}
 */
export function firstSegment(filename) {
  return filename.split('.')[0]
}

/**
 * @param {string} segment
 * @returns {string}
 */
export function toKebab(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isAllowedSegment(segment) {
  return /^_?[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)
}

/**
 * @param {string} filename
 * @returns {boolean}
 */
export function isAllowedFilename(filename) {
  return isAllowedSegment(firstSegment(filename))
}

/**
 * @param {string} [root]
 * @returns {string[]}
 */
export function collectSourceFiles(root = ROOT) {
  /** @type {string[]} */
  const files = []

  /** @param {string} directory */
  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(path)
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        files.push(path)
      }
    }
  }

  for (const workspaceDir of WORKSPACE_DIRS) {
    walk(join(root, workspaceDir))
  }

  return files.sort()
}

/**
 * @param {string[]} files
 * @returns {{file: string, basename: string, suggested: string}[]}
 */
export function findViolations(files) {
  return files.flatMap((file) => {
    const name = basename(file)
    const segment = firstSegment(name)
    if (isAllowedSegment(segment)) return []
    const privatePrefix = segment.startsWith('_') ? '_' : ''
    const bareSegment = privatePrefix === '' ? segment : segment.slice(1)
    return [
      {
        file,
        basename: name,
        suggested: name.replace(
          segment,
          `${privatePrefix}${toKebab(bareSegment)}`,
        ),
      },
    ]
  })
}

function main() {
  const violations = findViolations(collectSourceFiles())
  if (violations.length === 0) return

  console.error(
    `kebab-case filename check failed: ${violations.length} source file(s) are not kebab-case.`,
  )
  console.error(
    'Source filenames under apps/ and packages/ must be kebab-case (exported symbols may stay PascalCase/camelCase).',
  )
  for (const violation of violations) {
    console.error(
      `  ${relative(ROOT, violation.file)}  ->  rename to "${violation.suggested}"`,
    )
  }
  process.exitCode = 1
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main()
}
