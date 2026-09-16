#!/usr/bin/env node
// Editorial guard over the docs vocabulary. Two categories of rule, each with
// its own reach, because they answer different questions.
//
// **Internal identifiers — `guide/`, `operations/` and `reference/` only.**
// Those folders are written for people who use or run Crowi, not for people
// who read its source. An RFC number, a spec id, a repository path, a
// middleware name or a model field leaks the writer's mental model into a page
// whose reader cannot resolve it, and it goes stale the moment the code moves.
// `develop/` names internals on purpose, so these rules skip it.
//
// **Canonical terminology — every page, `develop/` included.** One concept has
// one name across the docs, and a page that reaches for a second name is wrong
// wherever it sits: a developer reading `develop/` and a user reading `guide/`
// have to be able to talk to each other. These rules are per-locale, since the
// canonical name is a Japanese word on a `ja/` page and an English one on an
// `en/` page.
//
// The terminology rules come from two places. A handful are written out below,
// because the shape of the drift needed a hand-tuned expression. The rest are
// generated from `docs-glossary.json`, which is the data behind the
// `reference/glossary` page: one rule per concept and locale, matching the
// spellings that concept must not be called. Editing the vocabulary therefore
// means editing that file, and a test asserts every canonical name it declares
// really appears on the glossary page, so the data and the page cannot drift.
//
// Only prose is scanned: fenced code blocks are skipped through the same
// `proseLines` helper the link checker uses, because a shell transcript or a
// config sample legitimately contains paths and identifiers. A terminology
// rule additionally opts into `strip: 'code-and-links'`, which blanks inline
// code spans and link destinations before matching — the identifier rules
// cannot use it, because the backticks are what they match on.
//
// A rule that fires on a legitimate sentence is silenced from
// `docs-vocabulary-allow.json` — an entry names the page, the rule and the
// reason — so an exception never requires editing this file.

import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectDocsFiles, DOCS_DIR, proseLines } from './check-docs-links.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOW_FILE = join(ROOT, 'scripts', 'docs-vocabulary-allow.json')
const GLOSSARY_FILE = join(ROOT, 'scripts', 'docs-glossary.json')
// Every locale the docs are written in. A terminology rule is per-locale, so
// the glossary declares one entry per concept and locale.
export const LOCALES = ['ja', 'en']
// The folders whose reader cannot resolve an internal name. `develop/` is
// deliberately absent: it is the folder that may name internals.
const READER_FOLDERS = new Set(['guide', 'operations', 'reference'])

// Every alternative of the `internal-symbol` rule, one per line so a new leak
// can be added — and the list reviewed — without editing a single long regex.
// Entries are regex fragments, not literals: `(?:Config|Page|…)\.\w+` covers a
// static model call whatever the method is called.
const INTERNAL_SYMBOLS = [
  'jwtAdminRequired',
  'jwtAuth',
  'createJwtAuth',
  'createJwtAdminRequired',
  'registerStorage',
  'registerRoutes',
  'registerSearch',
  'SearchRegistry',
  'StateCell',
  'modelAccess',
  'PluginContext',
  'CrowiPlugin',
  '(?:Config|Page|User|Revision|Attachment)\\.\\w+',
  'loadAllConfig',
  'updateByParams',
  'invalidateLiveCollabDoc',
  'KNOWN_HTML_ELEMENTS',
  'PageYjsUpdate',
  'collabLifecycleVersion',
  'Redlock',
  'KeyProvider',
  'SecretField',
  'Revision',
  'savedBy',
  'contributors',
  'liker',
  'currentRevision',
  'yjsState',
  'secretKeyword',
  'driverName',
  'pluginName',
  'isActive',
  'activeDriver',
  'activePlugin',
  'configSchema',
  'configI18n',
  'adminPlacement',
  'requireThirdPartyAuth',
  'disablePasswordAuth',
  'rendererVersion',
  'rendererStylesheets',
  'recipeVersion',
  'derivatives\\.display',
  'lastUpdateUser',
  'updatedAt',
  'projectDir',
  'wsToken',
  'pageId',
  'parseBody',
  'wikilink-broken',
  'Link2',
  'BookmarkCheck',
  'fill-current',
]

// Library names the api happens to be built on. An operator never installs or
// configures these directly — they are dependencies of `@crowi/api` — so a
// reader-facing page that names one is describing the implementation.
const LIBRARY_NAMES = ['Hocuspocus', 'Mongoose', 'Yjs']

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} message
 * @property {Set<string>} [folders] the folders the rule applies to; every
 *   folder, and the locale-root pages, when absent
 * @property {string} [locale] the locale the rule applies to; every locale
 *   when absent
 * @property {'code-and-links'} [strip] blank inline code spans and link
 *   destinations before matching
 */

/**
 * @type {Rule[]}
 *
 * Identifier rules quote the name in backticks on purpose. `contributors`,
 * `revision` and `deleted` are ordinary words in an English sentence and only
 * become a leak when the page presents them as the field the API returns.
 */
const STATIC_RULES = [
  {
    id: 'rfc-number',
    folders: READER_FOLDERS,
    // Crowi's own RFCs are always written `RFC-0003`; an IETF reference
    // (`RFC 3986`) uses a space and is a legitimate citation for a reader.
    pattern: /RFC-\d{4}/g,
    message: 'RFC numbers belong in develop/rfcs — describe the behaviour instead',
  },
  {
    id: 'spec-id',
    folders: READER_FOLDERS,
    // Three or more segments on purpose: a real spec id always has them
    // (`feature-docs-ia-restructure`), while a two-segment match would fire on
    // ordinary English like "feature rich" written with a hyphen.
    pattern: /\bfeature-[a-z0-9]+(?:-[a-z0-9]+)+\b/g,
    message: 'internal spec id — readers cannot resolve it',
  },
  {
    id: 'repo-path',
    folders: READER_FOLDERS,
    pattern: /(?<![\w/.-])(?:packages|apps|scripts)\/[a-z0-9@][\w@./-]*/g,
    message: 'repository path — link to the page that documents the behaviour',
  },
  {
    id: 'source-path',
    folders: READER_FOLDERS,
    pattern: /(?<![\w/.-])src\/[\w@./-]+/g,
    message: 'source path — readers of guide/operations never open the source tree',
  },
  {
    id: 'source-file',
    folders: READER_FOLDERS,
    pattern: /`[\w./-]+\.(?:ts|tsx|mjs)`/g,
    message: 'source file name — describe the behaviour, not the file that implements it',
  },
  {
    id: 'css-token',
    folders: READER_FOLDERS,
    // Narrow on purpose: a bare `--page-…` also spells a CLI flag
    // (`crowi-admin … --page-id`), which is exactly what an operator types.
    pattern: /--(?:crowi-[a-z0-9-]+|[a-z0-9-]+-accent)/g,
    message: 'CSS custom property — an implementation detail of the theme',
  },
  {
    id: 'function-call',
    folders: READER_FOLDERS,
    // Any backticked call spelling — `parseBody()`, `process.cwd()`,
    // `createRequire(projectDir)`. A reader-facing page describes what
    // happens, never the function that makes it happen, so this needs no
    // per-name list. The call has to end the backticked span, which keeps
    // `http(s)://` out; CLI invocations carry no parentheses at all.
    pattern: /`[A-Za-z_$][\w$.]*\([^`)]*\)`/g,
    message: 'function name — describe what happens, not the call that does it',
  },
  {
    id: 'internal-symbol',
    folders: READER_FOLDERS,
    pattern: new RegExp(`\`(?:${INTERNAL_SYMBOLS.join('|')})\``, 'g'),
    message: 'internal symbol — use the word a reader of this page would use',
  },
  {
    id: 'library-name',
    folders: READER_FOLDERS,
    // Matched bare, unlike `internal-symbol`: these are proper-noun library
    // names that never occur as an ordinary word, so there is no sentence a
    // backtick requirement would protect. Naming the library an operator never
    // installs or configures describes the implementation, not the behaviour —
    // say what capability it needs instead.
    pattern: new RegExp(`\\b(?:${LIBRARY_NAMES.join('|')})\\b`, 'g'),
    message: 'library name — describe the capability the api needs, not the package that provides it',
  },
  {
    id: 'ja-revision',
    locale: 'ja',
    strip: 'code-and-links',
    // Lowercase on purpose. `Revision` with a capital is the model, which a
    // `develop/` page may legitimately name, and `revision_id` / `?revision_id=`
    // is the query parameter an operator really types — the lookahead rejects
    // anything that continues into a longer identifier, and `strip` has already
    // blanked the code span it normally sits in. What is left is the bare Latin
    // word in a Japanese sentence, which is the drift: a page that writes it
    // twice in two spellings reads as two different concepts.
    pattern: /(?<![\w?=/#.-])revisions?(?![\w-])/g,
    message: '履歴の単位の呼び名は「リビジョン」— ラテン語綴りを混ぜない',
  },
  {
    id: 'ja-revision-model',
    locale: 'ja',
    folders: READER_FOLDERS,
    strip: 'code-and-links',
    // The capitalised sibling of `ja-revision`, and the gap both other rules
    // left: `internal-symbol` only sees `Revision` in backticks, `ja-revision`
    // only the lowercase word, so a bare capitalised model name in a Japanese
    // sentence passed each of them. Reader-facing folders only — `develop/`
    // names the model on purpose, and the `strip` keeps the backticked form to
    // `internal-symbol` so one occurrence is never reported twice.
    pattern: /(?<![\w?=/#.-])Revisions?(?![\w-])/g,
    message: '履歴の単位の呼び名は「リビジョン」— モデル名を読者向けページに書かない',
  },
  {
    id: 'notification-sink',
    // Not locale-scoped, unlike `ja-revision`: "revision" is a word English
    // prose owns, but "notification sink" is nobody's canonical name, so the
    // phrase is a second name for the concept on a `ja/` page as much as on an
    // `en/` one. No `strip` either — the capability is spelled
    // `registerNotifier`, so no identifier, URL or code sample legitimately
    // reads this way.
    pattern: /\bnotification[- ]sinks?\b/gi,
    message: 'the concept is a notifier plugin (通知プラグイン) — "notification sink" is a second name for it',
  },
]

/**
 * @typedef {object} GlossaryLocaleEntry
 * @property {string} canonical the one name this locale calls the concept, a
 *   literal, which has to appear on that locale's reference/glossary page
 * @property {string[]} variants regex sources for the spellings it must not be
 *   called; empty when there is nothing to guard yet, or when a hand-written
 *   rule already covers the concept
 */

/**
 * @typedef {{concept: string, ja: GlossaryLocaleEntry, en: GlossaryLocaleEntry}} GlossaryEntry
 */

/**
 * @param {string} [file]
 * @returns {GlossaryEntry[]}
 */
export function loadGlossary(file = GLOSSARY_FILE) {
  /** @type {{concepts: GlossaryEntry[]}} */
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  return parsed.concepts
}

/**
 * The rule id a concept's variants are reported under. Stable across an edit
 * to the variant list, so an allow-list entry naming it keeps working.
 * @param {string} concept
 * @param {string} locale
 * @returns {string}
 */
export function glossaryRuleId(concept, locale) {
  return `glossary-${concept}-${locale}`
}

/**
 * Turn the glossary into one rule per concept and locale. Same shape as the
 * hand-written terminology rules: locale-scoped, every folder, and `strip` so a
 * code span or a link destination that happens to spell a variant is not prose.
 * @param {GlossaryEntry[]} glossary
 * @returns {Rule[]}
 */
export function glossaryRules(glossary) {
  /** @type {Rule[]} */
  const rules = []

  for (const entry of glossary) {
    for (const locale of LOCALES) {
      const { canonical, variants } = entry[locale]
      if (variants.length === 0) continue

      rules.push({
        id: glossaryRuleId(entry.concept, locale),
        locale,
        strip: 'code-and-links',
        pattern: new RegExp(variants.join('|'), 'g'),
        message:
          locale === 'ja'
            ? `この概念の呼び名は「${canonical}」— 用語集 (reference/glossary) の語に揃える`
            : `this concept is called “${canonical}” — use the name the glossary (reference/glossary) registers`,
      })
    }
  }

  return rules
}

/** @type {Rule[]} */
export const RULES = [...STATIC_RULES, ...glossaryRules(loadGlossary())]

/**
 * @typedef {{path: string, pattern: string, why: string}} AllowEntry
 */

/**
 * @param {string} [file]
 * @returns {AllowEntry[]}
 */
export function loadAllowList(file = ALLOW_FILE) {
  /** @type {{allow: AllowEntry[]}} */
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  return parsed.allow
}

/**
 * @typedef {{locale: string | undefined, folder: string | undefined}} PageScope
 *
 * Which rules reach a page. `folder` is undefined for a locale-root page
 * (`ja/index.mdx`), which the folder-scoped identifier rules therefore skip
 * while the terminology rules still cover it.
 */

/**
 * @param {string} docsRelativePath a path below content/docs, e.g. `ja/guide/cli.mdx`
 * @returns {PageScope}
 */
export function pageScope(docsRelativePath) {
  const [locale, second, ...rest] = docsRelativePath.split(sep)
  return { locale, folder: rest.length > 0 ? second : undefined }
}

/**
 * @param {Rule} rule
 * @param {PageScope} page
 * @returns {boolean}
 */
function ruleApplies(rule, page) {
  if (rule.folders !== undefined && (page.folder === undefined || !rule.folders.has(page.folder))) return false
  return rule.locale === undefined || rule.locale === page.locale
}

const CODE_SPAN_RE = /`[^`]*`/g
const LINK_DEST_RE = /\]\([^)]*\)/g

/**
 * Blank the spans of a prose line that hold identifiers rather than wording:
 * inline code and the destination of a markdown link. Replaced with spaces of
 * the same length so a column offset still lines up with the source. Code
 * spans go first, so a destination inside one is already gone.
 * @param {string} text
 * @returns {string}
 */
function stripCodeAndLinks(text) {
  return text
    .replace(CODE_SPAN_RE, (span) => ' '.repeat(span.length))
    .replace(LINK_DEST_RE, (dest) => `](${' '.repeat(dest.length - 3)})`)
}

/**
 * @param {string} source
 * @param {PageScope} page
 * @param {string[]} [silencedRules] rule ids the allow list turned off for this page
 * @returns {{rule: string, line: number, text: string, message: string}[]}
 */
export function findLeaks(source, page, silencedRules = []) {
  const silenced = new Set(silencedRules)
  const rules = RULES.filter((rule) => !silenced.has(rule.id) && ruleApplies(rule, page))
  const anyStrips = rules.some((rule) => rule.strip === 'code-and-links')
  /** @type {{rule: string, line: number, text: string, message: string}[]} */
  const leaks = []

  for (const { text, line } of proseLines(source)) {
    const stripped = anyStrips ? stripCodeAndLinks(text) : text
    for (const rule of rules) {
      const subject = rule.strip === 'code-and-links' ? stripped : text
      for (const match of subject.matchAll(rule.pattern)) {
        leaks.push({ rule: rule.id, line, text: match[0], message: rule.message })
      }
    }
  }

  return leaks
}

/**
 * @param {string[]} files
 * @param {AllowEntry[]} allow
 * @param {string} [root]
 * @returns {{violations: {file: string, rule: string, line: number, text: string, message: string}[], readerFacing: number}}
 */
export function findVocabularyLeaks(files, allow, root = ROOT) {
  const docsRoot = join(root, DOCS_DIR)
  /** @type {{file: string, rule: string, line: number, text: string, message: string}[]} */
  const violations = []
  let readerFacing = 0

  for (const file of files) {
    // Every page is scanned: the canonical-term rules carry no folder or
    // locale scope, so there is no page a rule cannot apply to.
    const page = pageScope(relative(docsRoot, file))
    if (page.folder !== undefined && READER_FOLDERS.has(page.folder)) readerFacing += 1

    const repoRelative = relative(root, file).split(sep).join('/')
    const silenced = allow.filter((entry) => entry.path === repoRelative).map((entry) => entry.pattern)
    for (const leak of findLeaks(readFileSync(file, 'utf8'), page, silenced)) {
      violations.push({ file: repoRelative, ...leak })
    }
  }

  return { violations, readerFacing }
}

function main() {
  const files = collectDocsFiles()
  if (files.length === 0) {
    console.error(`docs vocabulary check failed: no pages found under ${DOCS_DIR}.`)
    process.exitCode = 1
    return
  }

  const { violations, readerFacing } = findVocabularyLeaks(files, loadAllowList())
  if (violations.length === 0) {
    console.log(`docs vocabulary check: ${files.length} page(s) use the canonical vocabulary, ${readerFacing} of them name no internals.`)
    return
  }

  console.error(`docs vocabulary check failed: ${violations.length} vocabulary violation(s).`)
  console.error('guide/, operations/ and reference/ describe behaviour; develop/ is where internals may be named.')
  console.error('The canonical-term rules apply everywhere, develop/ included — one concept, one name.')
  console.error(`Add a {path, pattern, why} entry to ${relative(ROOT, ALLOW_FILE)} for a legitimate occurrence.`)
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  [${violation.rule}] ${violation.text}  ->  ${violation.message}`)
  }
  process.exitCode = 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
