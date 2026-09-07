import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { findLeaks, findVocabularyLeaks, isScannedPage, loadAllowList, pageScope, RULES } from './check-docs-vocabulary.mjs'
import { collectDocsFiles, DOCS_DIR } from './check-docs-links.mjs'

// Violations report a repo-relative path with forward slashes, whatever the
// platform separator is.
const docsPath = (...segments) => [...DOCS_DIR.split(sep), ...segments].join('/')

// The scope every identifier rule reaches. Named so a test that is about a
// rule rather than about scoping does not have to restate it.
const EN_GUIDE = { locale: 'en', folder: 'guide' }
const EN_DEVELOP = { locale: 'en', folder: 'develop' }
const JA_GUIDE = { locale: 'ja', folder: 'guide' }
const JA_DEVELOP = { locale: 'ja', folder: 'develop' }

describe('check-docs-vocabulary', () => {
  describe('pageScope', () => {
    it('splits a page path into the locale and the folder that own it', () => {
      assert.deepEqual(pageScope(join('ja', 'guide', 'cli.mdx')), { locale: 'ja', folder: 'guide' })
      assert.deepEqual(pageScope(join('en', 'develop', 'architecture.mdx')), { locale: 'en', folder: 'develop' })
    })

    it('reports no folder for a locale-root page', () => {
      assert.deepEqual(pageScope(join('ja', 'index.mdx')), { locale: 'ja', folder: undefined })
    })
  })

  describe('isScannedPage', () => {
    it('scans every page, because the canonical-term rules are not folder-scoped', () => {
      assert.equal(isScannedPage(join('ja', 'guide', 'cli.mdx')), true)
      assert.equal(isScannedPage(join('en', 'operations', 'redis.mdx')), true)
      assert.equal(isScannedPage(join('ja', 'reference', 'env.mdx')), true)
      assert.equal(isScannedPage(join('ja', 'develop', 'architecture.mdx')), true)
      assert.equal(isScannedPage(join('ja', 'index.mdx')), true)
    })
  })

  describe('findLeaks', () => {
    it('reports an RFC number, a spec id and a repository path with their line numbers', () => {
      const source = ['see RFC-0003 for the design', 'tracked as feature-docs-ia-restructure', 'lives in packages/api/src/collab'].join('\n')

      assert.deepEqual(
        findLeaks(source, EN_GUIDE).map((leak) => `${leak.line} ${leak.rule} ${leak.text}`),
        ['1 rfc-number RFC-0003', '2 spec-id feature-docs-ia-restructure', '3 repo-path packages/api/src/collab'],
      )
    })

    it('leaves an IETF citation alone — only Crowi RFCs are written with a hyphen', () => {
      assert.deepEqual(findLeaks('percent-encoding follows RFC 3986', EN_GUIDE), [])
    })

    it('does not mistake a CLI flag for a CSS custom property', () => {
      assert.deepEqual(findLeaks('run `crowi-admin page-history repair --page-id abc`', EN_GUIDE), [])
      assert.equal(findLeaks('the strip reads `--page-grant-accent`', EN_GUIDE)[0].rule, 'css-token')
    })

    it('flags an internal symbol only when the page presents it as an identifier', () => {
      assert.deepEqual(findLeaks('the revision records its contributors', EN_GUIDE), [])
      assert.equal(findLeaks('the revision records `contributors`', EN_GUIDE)[0].rule, 'internal-symbol')
      assert.equal(findLeaks('the response carries `driverName`', EN_GUIDE)[0].rule, 'internal-symbol')
    })

    it('flags a library name bare, where an internal symbol needs its backticks', () => {
      assert.equal(findLeaks('the api is a long-lived Mongoose client', EN_GUIDE)[0].rule, 'library-name')
      assert.equal(findLeaks('the embedded Hocuspocus engine', EN_GUIDE)[0].rule, 'library-name')
      assert.deepEqual(findLeaks('the revision records its contributors', EN_GUIDE), [])
    })

    it('flags any function call, without a list of names to maintain', () => {
      assert.deepEqual(
        findLeaks(['the api calls `parseBody()`', 'started where `process.cwd()` points', 'proxied by `rewrites()`'].join('\n'), EN_GUIDE).map(
          (leak) => `${leak.line} ${leak.rule} ${leak.text}`,
        ),
        ['1 function-call `parseBody()`', '2 function-call `process.cwd()`', '3 function-call `rewrites()`'],
      )
    })

    it('flags a call that takes an argument too', () => {
      assert.equal(findLeaks('resolved with `createRequire(projectDir)`', EN_GUIDE)[0].rule, 'function-call')
    })

    it('does not mistake a CLI invocation or a URL scheme for a function call', () => {
      assert.deepEqual(findLeaks('run `crowi-admin rebuild search` from the runner project', EN_GUIDE), [])
      assert.deepEqual(findLeaks('external URLs such as `http(s)://` are dimmed', EN_GUIDE), [])
    })

    it('leaves a function call inside fenced code alone', () => {
      const source = ['prose', '```ts', 'z.string().describe()', '```', 'more prose'].join('\n')

      assert.deepEqual(findLeaks(source, EN_GUIDE), [])
    })

    it('skips fenced code, where a path or an identifier is legitimate', () => {
      const source = ['prose', '```bash', 'node packages/api/dist/app.js', '```', 'more prose'].join('\n')

      assert.deepEqual(findLeaks(source, EN_GUIDE), [])
    })

    it('silences the rules the allow list names for that page', () => {
      const source = 'the sample lives in src/pages'

      assert.equal(findLeaks(source, EN_GUIDE).length, 1)
      assert.deepEqual(findLeaks(source, EN_GUIDE, ['source-path']), [])
    })
  })

  describe('rule scope', () => {
    it('lets develop/ name the internals every other folder may not', () => {
      const source = ['see RFC-0003 for the design', 'lives in packages/api/src/collab', 'the response carries `driverName`', 'a long-lived Mongoose client'].join(
        '\n',
      )

      assert.deepEqual(findLeaks(source, EN_DEVELOP), [])
      assert.equal(findLeaks(source, EN_GUIDE).length, 4)
    })

    it('leaves the locale-root page to the canonical-term rules only', () => {
      assert.deepEqual(findLeaks('see RFC-0003 for the design', { locale: 'ja', folder: undefined }), [])
    })
  })

  describe('the ja-revision rule', () => {
    // The straggler four review rounds of hand-grepping missed, quoted as it
    // stood: the same file said 「リビジョン」 two lines below.
    it('flags the Latin spelling in a Japanese sentence, in guide/ and in develop/ alike', () => {
      const source = 'Crowi のリアルタイム編集は **明示的な保存ボタンを押した瞬間に\nrevision が作成される** モデルです。'

      assert.deepEqual(
        findLeaks(source, JA_GUIDE).map((leak) => `${leak.line} ${leak.rule} ${leak.text}`),
        ['2 ja-revision revision'],
      )
      assert.equal(findLeaks(source, JA_DEVELOP)[0].rule, 'ja-revision')
    })

    it('flags the plural too', () => {
      assert.equal(findLeaks('古い revisions は残ります。', JA_GUIDE)[0].rule, 'ja-revision')
    })

    it('accepts the canonical Japanese name', () => {
      assert.deepEqual(findLeaks('保存した瞬間にリビジョンが作成されます。', JA_DEVELOP), [])
    })

    it('leaves the query parameter an operator really types alone', () => {
      assert.deepEqual(findLeaks('`edit` はページの `revision_id` を送って楽観ロックします。', JA_GUIDE), [])
      assert.deepEqual(findLeaks('過去版を `?revision_id=` で開くと', JA_GUIDE), [])
    })

    it('leaves the model name alone, which develop/ may write bare', () => {
      assert.deepEqual(findLeaks('モデルには Page / Revision / User / Comment があります。', JA_DEVELOP), [])
      assert.deepEqual(findLeaks('ページの `currentRevision` を参照します。', JA_DEVELOP), [])
    })

    it('leaves a migration name and a link destination alone', () => {
      assert.deepEqual(findLeaks('boot 移行 (`revisions-schema-unify`) は api 起動時に走ります。', JA_GUIDE), [])
      assert.deepEqual(findLeaks('- [ページ履歴](./revisions) — 過去のリビジョンを見る', JA_GUIDE), [])
    })

    it('does not touch English prose, which owns the word', () => {
      assert.deepEqual(findLeaks('the page keeps every revision it ever had', EN_GUIDE), [])
      assert.deepEqual(findLeaks('older revisions stay in the history', EN_DEVELOP), [])
    })
  })

  describe('the notification-sink rule', () => {
    // The other straggler, quoted as it stood: the ja cell one line away had
    // already become 「通知プラグイン」.
    it('flags the second name for a notifier plugin, in develop/ included', () => {
      assert.equal(findLeaks('| `registerNotifier` | A notification sink |', EN_DEVELOP)[0].rule, 'notification-sink')
      assert.equal(findLeaks('a notification sink receives the event', EN_GUIDE)[0].rule, 'notification-sink')
    })

    it('flags the hyphenated and plural spellings, and ignores case', () => {
      assert.equal(findLeaks('Notification sinks are registered at boot', EN_DEVELOP)[0].rule, 'notification-sink')
      assert.equal(findLeaks('a notification-sink plugin', EN_DEVELOP)[0].rule, 'notification-sink')
    })

    it('accepts the canonical phrase', () => {
      assert.deepEqual(findLeaks('| `registerNotifier` | A notifier plugin |', EN_DEVELOP), [])
      assert.deepEqual(findLeaks('configuring notifier plugins', EN_GUIDE), [])
    })
  })

  describe('the shipped allow list', () => {
    it('names only rules that exist', () => {
      const ids = new Set(RULES.map((rule) => rule.id))

      for (const entry of loadAllowList()) {
        assert.ok(ids.has(entry.pattern), `unknown rule id in the allow list: ${entry.pattern}`)
        assert.ok(entry.why, `allow-list entry for ${entry.path} has no reason`)
      }
    })
  })

  describe('findVocabularyLeaks', () => {
    const root = mkdtempSync(join(tmpdir(), 'crowi-docs-vocab-'))

    before(() => {
      for (const locale of ['ja', 'en']) {
        mkdirSync(join(root, DOCS_DIR, locale, 'guide'), { recursive: true })
        mkdirSync(join(root, DOCS_DIR, locale, 'develop'), { recursive: true })
        writeFileSync(join(root, DOCS_DIR, locale, 'guide', 'cli.mdx'), 'designed in RFC-0012\n')
        writeFileSync(join(root, DOCS_DIR, locale, 'develop', 'architecture.mdx'), 'designed in RFC-0012\n')
      }
    })

    after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('scans develop/ too, but reports an internal identifier from the reader-facing pages only', () => {
      const { violations, scanned, readerFacing } = findVocabularyLeaks(collectDocsFiles(root), [], root)

      assert.equal(scanned, 4)
      assert.equal(readerFacing, 2)
      assert.deepEqual(
        violations.map((violation) => `${violation.file} ${violation.text}`),
        [`${docsPath('en', 'guide', 'cli.mdx')} RFC-0012`, `${docsPath('ja', 'guide', 'cli.mdx')} RFC-0012`],
      )
    })

    it('reports a canonical-term violation from a develop/ page', () => {
      writeFileSync(join(root, DOCS_DIR, 'ja', 'develop', 'plugins.mdx'), '保存すると revision が 1 件増えます。\n')
      writeFileSync(join(root, DOCS_DIR, 'en', 'develop', 'plugins.mdx'), '| `registerNotifier` | A notification sink |\n')

      const { violations } = findVocabularyLeaks(collectDocsFiles(root), [], root)

      assert.deepEqual(
        violations.filter((violation) => violation.file.endsWith('plugins.mdx')).map((violation) => `${violation.file} ${violation.rule}`),
        [`${docsPath('en', 'develop', 'plugins.mdx')} notification-sink`, `${docsPath('ja', 'develop', 'plugins.mdx')} ja-revision`],
      )

      rmSync(join(root, DOCS_DIR, 'ja', 'develop', 'plugins.mdx'))
      rmSync(join(root, DOCS_DIR, 'en', 'develop', 'plugins.mdx'))
    })

    it('applies an allow-list entry to the named page only', () => {
      const allow = [{ path: docsPath('ja', 'guide', 'cli.mdx'), pattern: 'rfc-number', why: 'test' }]
      const { violations } = findVocabularyLeaks(collectDocsFiles(root), allow, root)

      assert.deepEqual(
        violations.map((violation) => violation.file),
        [docsPath('en', 'guide', 'cli.mdx')],
      )
    })
  })
})
