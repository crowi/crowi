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
// Destinations are matched against the collected page list rather than probed
// with existsSync, so a wrong-case destination fails here even on a
// case-insensitive filesystem (macOS). The production host serves
// case-sensitively, and pre-push is the gate that runs on a developer laptop.
//
// Two destination shapes resolve to a file on disk but have no URL, so they are
// rejected rather than blessed: an explicit `.mdx` / `.md` extension (site URLs
// carry none) and a trailing `index` segment (index.mdx is served at its folder
// URL, never at `<folder>/index`).
//
// Out of scope (skipped, not resolved): external URLs, `mailto:`, root-absolute
// paths (docs pages use those for wiki-content examples like `/foo bar`), and
// same-page anchors. Fragments are stripped before resolving, so
// `./redis#acl` only checks that `redis.mdx` exists — not the heading.
// JSX attributes are not scanned, so `<Card href="…">` is not covered.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DOCS_DIR = join('apps', 'crowi-site', 'content', 'docs')
const PAGE_EXT = /\.mdx?$/
const LINK_RE = /\]\(([^)]*)\)/g
// An opening fence is 3+ backticks or tildes; the closing fence must use the
// same character and be at least as long (CommonMark). Tracking the marker
// instead of toggling a boolean keeps a nested example fence — ```` wrapping
// ``` , which guide/markdown.mdx really contains — from inverting the state and
// silently switching link checking off for the rest of the file.
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

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
 * The prose lines of one page: every line that is not a fence marker and not
 * inside a fenced block. Shared with check-docs-vocabulary.mjs so both guards
 * agree on what counts as prose.
 * @param {string} source
 * @returns {{text: string, line: number}[]}
 */
export function proseLines(source) {
  /** @type {{text: string, line: number}[]} */
  const lines = []
  /** @type {string | null} */
  let openFence = null

  source.split('\n').forEach((text, index) => {
    const fence = FENCE_RE.exec(text)?.[1]
    if (fence) {
      if (openFence === null) {
        openFence = fence
        return
      }
      // Only a fence of the same character and at least the opening length
      // closes the block; anything shorter or of the other character is
      // content inside it.
      if (fence[0] === openFence[0] && fence.length >= openFence.length) openFence = null
      return
    }
    if (openFence !== null) return

    lines.push({ text, line: index + 1 })
  })

  return lines
}

/**
 * Collect the file-relative markdown links of one page, ignoring fenced code.
 * @param {string} source
 * @returns {{href: string, line: number}[]}
 */
export function extractRelativeLinks(source) {
  /** @type {{href: string, line: number}[]} */
  const links = []

  for (const { text, line } of proseLines(source)) {
    for (const match of text.matchAll(LINK_RE)) {
      const href = normalizeHref(match[1])
      if (isFileRelative(href)) links.push({ href, line })
    }
  }

  return links
}

/**
 * @param {string} fromFile absolute path of the page holding the link
 * @param {string} href a file-relative link destination
 * @param {string} localeRoot absolute path of content/docs/<locale>
 * @param {Set<string>} pages every page path that exists, exactly as on disk
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function resolveLink(fromFile, href, localeRoot, pages) {
  const path = href.split('#')[0].split('?')[0]
  if (path === '' || path === './') return { ok: true }

  if (PAGE_EXT.test(path)) {
    return { ok: false, reason: 'site URLs carry no file extension — drop the .mdx / .md' }
  }

  const target = resolve(dirname(fromFile), path)
  if (target !== localeRoot && !target.startsWith(localeRoot + sep)) {
    return { ok: false, reason: `resolves outside ${relative(ROOT, localeRoot)}` }
  }

  if (basename(target) === 'index') {
    return { ok: false, reason: 'index.mdx is served at its folder URL — link to the folder instead' }
  }

  const candidates = [`${target}.mdx`, join(target, 'index.mdx')]
  if (candidates.some((candidate) => pages.has(candidate))) return { ok: true }

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
  const pages = new Set(files)
  /** @type {{file: string, line: number, href: string, reason: string}[]} */
  const violations = []
  let checked = 0

  for (const file of files) {
    const locale = relative(docsRoot, file).split(sep)[0]
    const localeRoot = join(docsRoot, locale)

    for (const { href, line } of extractRelativeLinks(readFileSync(file, 'utf8'))) {
      checked += 1
      const result = resolveLink(file, href, localeRoot, pages)
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
