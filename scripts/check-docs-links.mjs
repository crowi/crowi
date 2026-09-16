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
//
// The `href` attribute of a JSX element (`<Card href="…">`) is checked too, but
// under the opposite rule: it must be root-absolute *and* carry the locale.
// `Card` hands its href straight to the link component, so it never passes
// through the relative-link resolver that the MDX `a` renderer installs — a
// locale-less `/docs/guide/quickstart` renders as a 404 while a build and a
// relative-link scan both stay green. Markdown destinations keep their
// root-absolute exemption: a docs page legitimately writes `/foo bar` as a
// sample wiki path, and only JSX carries hrefs the site itself has to resolve.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DOCS_DIR = join('apps', 'crowi-site', 'content', 'docs')
const PAGE_EXT = /\.mdx?$/
const LINK_RE = /\]\(([^)]*)\)/g
const JSX_HREF_RE = /\bhref=(?:"([^"]*)"|'([^']*)')/g
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
 * @param {string} href
 * @returns {boolean}
 */
function isExternal(href) {
  return /^(?:https?:\/\/|mailto:|tel:)/.test(href)
}

/**
 * The part of a destination that names a page: the fragment and the query
 * string are the browser's business, and a heading id is not checked.
 * @param {string} href
 * @returns {string}
 */
function pagePath(href) {
  return href.split('#')[0].split('?')[0]
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
  return collectFromProse(source, LINK_RE, (match) => {
    const href = normalizeHref(match[1])
    return isFileRelative(href) ? href : null
  })
}

/**
 * The prose scan both extractors above and below are built from: walk the
 * page's non-fenced lines, run one pattern over each, and keep the hrefs
 * `pick` accepts. Only the pattern and that choice differ between them.
 * @param {string} source
 * @param {RegExp} pattern
 * @param {(match: RegExpMatchArray) => string | null} pick href to keep, or null to skip
 * @returns {{href: string, line: number}[]}
 */
function collectFromProse(source, pattern, pick) {
  /** @type {{href: string, line: number}[]} */
  const found = []

  for (const { text, line } of proseLines(source)) {
    for (const match of text.matchAll(pattern)) {
      const href = pick(match)
      if (href != null) found.push({ href, line })
    }
  }

  return found
}

/**
 * Collect the `href` attribute of every JSX element on a page, ignoring fenced
 * code so a page that documents the card markup is not checked as if it linked.
 * @param {string} source
 * @returns {{href: string, line: number}[]}
 */
export function extractJsxHrefs(source) {
  return collectFromProse(source, JSX_HREF_RE, (match) => match[1] ?? match[2] ?? null)
}

/**
 * @param {string} fromFile absolute path of the page holding the link
 * @param {string} href a file-relative link destination
 * @param {string} localeRoot absolute path of content/docs/<locale>
 * @param {Set<string>} pages every page path that exists, exactly as on disk
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function resolveLink(fromFile, href, localeRoot, pages) {
  const path = pagePath(href)
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
 * Resolve a JSX `href`. The destination has to be the site URL of a page in the
 * same locale as the page holding it, spelled in full — `/ja/docs/guide/…`.
 * Once the `/{locale}/docs` prefix is off, the remainder is the same kind of
 * destination {@link resolveLink} already resolves, relative to the locale root.
 * The page holding the href is therefore irrelevant, unlike a markdown
 * destination, which resolves against the directory it sits in.
 * @param {string} href the attribute value
 * @param {string} localeRoot absolute path of content/docs/<locale>
 * @param {Set<string>} pages every page path that exists, exactly as on disk
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function resolveJsxHref(href, localeRoot, pages) {
  if (isExternal(href)) return { ok: true }

  const locale = basename(localeRoot)
  const prefix = `/${locale}/docs`
  const path = pagePath(href)
  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    return { ok: false, reason: `a JSX href must be the full site URL — start it with ${prefix}` }
  }

  // The tab root (`/ja/docs`) is `.` rather than `./`, which resolveLink
  // shortcuts as "same page" without looking anything up.
  const rest = path.slice(prefix.length).replace(/^\//, '')

  return resolveLink(join(localeRoot, 'index.mdx'), rest === '' ? '.' : `./${rest}`, localeRoot, pages)
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

    const source = readFileSync(file, 'utf8')

    /**
     * @param {{href: string, line: number}[]} hrefs
     * @param {(href: string) => {ok: true} | {ok: false, reason: string}} resolveHref
     */
    const scan = (hrefs, resolveHref) => {
      for (const { href, line } of hrefs) {
        checked += 1
        const result = resolveHref(href)
        if (!result.ok) violations.push({ file: relative(root, file), line, href, reason: result.reason })
      }
    }

    scan(extractRelativeLinks(source), (href) => resolveLink(file, href, localeRoot, pages))
    scan(extractJsxHrefs(source), (href) => resolveJsxHref(href, localeRoot, pages))
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
    console.log(`docs link check: ${checked} in-site link(s) across ${files.length} page(s) resolve.`)
    return
  }

  console.error(`docs link check failed: ${violations.length} in-site link(s) do not resolve.`)
  console.error('A markdown destination is resolved against the source directory of the page holding it (./sibling, ../folder/page).')
  console.error('A JSX href is the full site URL instead, locale included (/ja/docs/guide/quickstart).')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  ${violation.href}  ->  ${violation.reason}`)
  }
  process.exitCode = 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
