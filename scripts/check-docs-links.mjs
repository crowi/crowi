#!/usr/bin/env node
// Structural guard: every file-relative link between crowi-site docs pages
// must resolve to a page that exists.
//
// The docs site is a static export, so a broken in-site link is emitted as a
// plain anchor and the build stays green — nothing catches it until a reader
// hits a 404. Relative links are also the form that breaks when a page moves
// between folders, which is exactly what the docs IA restructure does.
//
// The resolution rule mirrors the `a` resolver in
// apps/crowi-site/src/app/[lang]/docs/[[...slug]]/page.tsx: a link is resolved
// against the *source directory* of the file that contains it, so `./sibling`
// is the same folder and `../other/page` is a sibling folder.
//
// Out of scope (skipped, not resolved): external URLs, `mailto:`, root-absolute
// paths (docs pages use those for wiki-content examples like `/foo bar`), and
// same-page anchors. Fragments are stripped before resolving, so
// `./redis#acl` only checks that `redis.mdx` exists — not the heading.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_DIR = join('apps', 'crowi-site', 'content', 'docs')
const PAGE_EXT = /\.mdx?$/
const LINK_RE = /\]\(([^)]*)\)/g
const FENCE_RE = /^\s*(```|~~~)/

/**
 * Strip the optional link title and angle brackets from a markdown destination.
 * @param {string} raw
 * @returns {string}
 */
function normalizeHref(raw) {
  let href = raw.trim()
  if (href.startsWith('<') && href.includes('>')) href = href.slice(1, href.indexOf('>'))
  const space = href.search(/\s/)
  return space === -1 ? href : href.slice(0, space)
}

/**
 * @param {string} href
 * @returns {boolean}
 */
function isFileRelative(href) {
  return /^\.\.?\//.test(href)
}

/**
 * Collect the file-relative markdown links of one page, ignoring fenced code.
 * @param {string} source
 * @returns {{href: string, line: number}[]}
 */
export function extractRelativeLinks(source) {
  /** @type {{href: string, line: number}[]} */
  const links = []
  let inFence = false

  source.split('\n').forEach((text, index) => {
    if (FENCE_RE.test(text)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    for (const match of text.matchAll(LINK_RE)) {
      const href = normalizeHref(match[1])
      if (isFileRelative(href)) links.push({ href, line: index + 1 })
    }
  })

  return links
}

/**
 * @param {string} fromFile absolute path of the page holding the link
 * @param {string} href a file-relative link destination
 * @param {string} localeRoot absolute path of content/docs/<locale>
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function resolveLink(fromFile, href, localeRoot) {
  const path = href.split('#')[0].split('?')[0]
  if (path === '' || path === './') return { ok: true }

  const target = resolve(dirname(fromFile), path)
  if (target !== localeRoot && !target.startsWith(localeRoot + sep)) {
    return { ok: false, reason: `resolves outside ${relative(ROOT, localeRoot)}` }
  }

  const candidates = PAGE_EXT.test(path) ? [target] : [`${target}.mdx`, join(target, 'index.mdx')]
  if (candidates.some((candidate) => existsSync(candidate))) return { ok: true }

  return { ok: false, reason: `no such page (looked for ${candidates.map((c) => relative(ROOT, c)).join(' / ')})` }
}

/**
 * @param {string} [root]
 * @returns {string[]}
 */
export function collectDocsFiles(root = ROOT) {
  const docsRoot = join(root, DOCS_DIR)
  if (!existsSync(docsRoot)) return []

  return readdirSync(docsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && PAGE_EXT.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/**
 * @param {string[]} files
 * @param {string} [root]
 * @returns {{violations: {file: string, line: number, href: string, reason: string}[], checked: number}}
 */
export function findBrokenLinks(files, root = ROOT) {
  const docsRoot = join(root, DOCS_DIR)
  /** @type {{file: string, line: number, href: string, reason: string}[]} */
  const violations = []
  let checked = 0

  for (const file of files) {
    const locale = relative(docsRoot, file).split(sep)[0]
    const localeRoot = join(docsRoot, locale)

    for (const { href, line } of extractRelativeLinks(readFileSync(file, 'utf8'))) {
      checked += 1
      const result = resolveLink(file, href, localeRoot)
      if (!result.ok) violations.push({ file: relative(root, file), line, href, reason: result.reason })
    }
  }

  return { violations, checked }
}

function main() {
  const files = collectDocsFiles()
  if (files.length === 0) {
    console.error(`docs link check failed: no pages found under ${DOCS_DIR}.`)
    process.exitCode = 1
    return
  }

  const { violations, checked } = findBrokenLinks(files)
  if (violations.length === 0) {
    console.log(`docs link check: ${checked} relative link(s) across ${files.length} page(s) resolve.`)
    return
  }

  console.error(`docs link check failed: ${violations.length} relative link(s) do not resolve.`)
  console.error('Links are resolved against the source directory of the page holding them (./sibling, ../folder/page).')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  ${violation.href}  ->  ${violation.reason}`)
  }
  process.exitCode = 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
