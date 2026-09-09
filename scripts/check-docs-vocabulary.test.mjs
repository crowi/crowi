import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findLeaks, findVocabularyLeaks, glossaryRuleId, loadAllowList, loadGlossary, LOCALES, pageScope, RULES } from './check-docs-vocabulary.mjs'
import { collectDocsFiles, DOCS_DIR } from './check-docs-links.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

  describe('the glossary-driven rules', () => {
    it('registers every concept the documentation had two names for', () => {
      // Spelled out here on purpose: the rest of this block iterates the
      // glossary file, so a concept dropped from it would take its own
      // coverage with it and leave a name unguarded with every test green.
      // The list is fixed here on purpose: a concept the docs start calling
      // two things belongs on the glossary page and in this list, together.
      assert.deepEqual(loadGlossary().map((entry) => entry.concept).sort(), [
        'account-settings-tabs',
        'mail-delivery',
        'notifier-plugin',
        'personal-access-token',
        'plugin-admin-page',
        'revision',
        'runner-project',
        'search-backend-setup',
        'sensitive-config-encryption',
        'storage-settings',
      ])
    })

    it('builds one rule per concept and locale that has a variant to guard', () => {
      const ids = new Set(RULES.map((rule) => rule.id))

      for (const entry of loadGlossary()) {
        for (const locale of LOCALES) {
          const id = glossaryRuleId(entry.concept, locale)
          assert.equal(ids.has(id), entry[locale].variants.length > 0, `${id} should ${entry[locale].variants.length > 0 ? '' : 'not '}exist`)
        }
      }
    })

    it('defines every canonical name on the reference glossary page of its locale', () => {
      for (const locale of LOCALES) {
        const page = readFileSync(join(ROOT, DOCS_DIR, locale, 'reference', 'glossary.mdx'), 'utf8')

        for (const entry of loadGlossary()) {
          assert.ok(page.includes(entry[locale].canonical), `${locale}/reference/glossary.mdx does not define ${entry[locale].canonical}`)
        }
      }
    })

    it('never flags a canonical name with its own concept rules', () => {
      for (const locale of LOCALES) {
        for (const entry of loadGlossary()) {
          assert.deepEqual(findLeaks(entry[locale].canonical, { locale, folder: 'reference' }), [], `${locale} ${entry.concept}`)
        }
      }
    })

    it('flags a link labelled with a name the page it opens does not have', () => {
      assert.equal(findLeaks('詳しくは [プラグインの管理](../operations/plugins) を参照してください。', JA_GUIDE)[0].rule, glossaryRuleId('plugin-admin-page', 'ja'))
      assert.equal(findLeaks('see [Managing plugins](../operations/plugins) for the form', EN_GUIDE)[0].rule, glossaryRuleId('plugin-admin-page', 'en'))
    })

    it('leaves a sentence that merely contains those words alone', () => {
      assert.deepEqual(findLeaks('プラグインの管理方法は [プラグインの導入と設定](../operations/plugins) にあります。', JA_GUIDE), [])
    })

    it('flags a second name for a term wherever it sits, develop/ included', () => {
      assert.equal(findLeaks('パーソナルアクセストークンを発行します。', JA_DEVELOP)[0].rule, glossaryRuleId('personal-access-token', 'ja'))
      assert.equal(findLeaks('runner パッケージに依存を足します。', JA_GUIDE)[0].rule, glossaryRuleId('runner-project', 'ja'))
      assert.equal(findLeaks('add it to the runner package', EN_DEVELOP)[0].rule, glossaryRuleId('runner-project', 'en'))
    })

    it('scopes a rule to the locale whose word it is', () => {
      assert.deepEqual(findLeaks('パーソナルアクセストークンを発行します。', EN_GUIDE), [])
      assert.deepEqual(findLeaks('add it to the runner package', JA_GUIDE), [])
    })

    it('accepts the settings tab label as the UI spells it', () => {
      assert.deepEqual(findLeaks('**設定 → パスワード/APIトークン/アカウント連携** から発行します。', JA_GUIDE), [])
      assert.deepEqual(
        findLeaks('設定 → パスワード / APIトークン / MCP から発行します。', JA_GUIDE).map((leak) => leak.rule),
        [glossaryRuleId('account-settings-tabs', 'ja')],
      )
    })

    it('leaves a variant inside fenced code alone', () => {
      const source = ['prose', '```bash', 'pnpm --filter @crowi/runner-app add @crowi/plugin-slack # runner パッケージ', '```', 'prose'].join('\n')

      assert.deepEqual(findLeaks(source, JA_GUIDE), [])
    })
  })

  describe('the ja-revision-model rule', () => {
    // Two review rounds of Phase 1 shipped this shape: `internal-symbol` only
    // sees the backticked form and `ja-revision` only the lowercase one, so a
    // bare capitalised model name in a Japanese sentence passed both.
    it('flags the capitalised model name on a reader-facing Japanese page', () => {
      assert.equal(findLeaks('保存すると Revision が 1 件増えます。', JA_GUIDE)[0].rule, 'ja-revision-model')
      assert.equal(findLeaks('Revision ドキュメントに残ります。', { locale: 'ja', folder: 'reference' })[0].rule, 'ja-revision-model')
    })

    it('leaves develop/ alone, where the model is the subject', () => {
      assert.deepEqual(findLeaks('モデルには Page / Revision / User / Comment があります。', JA_DEVELOP), [])
    })

    it('does not double-report the backticked form internal-symbol already owns', () => {
      assert.deepEqual(
        findLeaks('ページの `Revision` を参照します。', JA_GUIDE).map((leak) => leak.rule),
        ['internal-symbol'],
      )
    })

    it('does not touch English prose', () => {
      assert.deepEqual(findLeaks('the Revision model keeps the body', EN_DEVELOP), [])
      assert.deepEqual(findLeaks('the Revision model keeps the body', EN_GUIDE), [])
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
      const files = collectDocsFiles(root)
      const { violations, readerFacing } = findVocabularyLeaks(files, [], root)

      assert.equal(files.length, 4)
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
