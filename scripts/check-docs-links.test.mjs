import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { collectDocsFiles, DOCS_DIR, extractJsxHrefs, extractRelativeLinks, findBrokenLinks, resolveJsxHref, resolveLink } from './check-docs-links.mjs'

describe('check-docs-links', () => {
  describe('extractRelativeLinks', () => {
    it('collects file-relative links and their line numbers', () => {
      const source = ['intro', 'see [storage](./storage) and [markdown](../guide/markdown).'].join('\n')

      assert.deepEqual(extractRelativeLinks(source), [
        { href: './storage', line: 2 },
        { href: '../guide/markdown', line: 2 },
      ])
    })

    it('keeps fragments but drops link titles and angle brackets', () => {
      const source = '[a](./redis#acl) [b](./redis "Redis") [c](<../develop/rfcs>)'

      assert.deepEqual(extractRelativeLinks(source), [
        { href: './redis#acl', line: 1 },
        { href: './redis', line: 1 },
        { href: '../develop/rfcs', line: 1 },
      ])
    })

    it('skips external, root-absolute and anchor-only destinations', () => {
      const source = ['[a](https://crowi.wiki)', '[b](mailto:x@example.com)', '[c](/foo bar)', '[d](#section)'].join('\n')

      assert.deepEqual(extractRelativeLinks(source), [])
    })

    it('ignores links inside fenced code blocks', () => {
      const source = ['[real](./storage)', '```md', '[sample](./not-a-page)', '```', '[real2](./mail)'].join('\n')

      assert.deepEqual(extractRelativeLinks(source), [
        { href: './storage', line: 1 },
        { href: './mail', line: 5 },
      ])
    })

    it('keeps checking after a nested example fence closes its outer block', () => {
      // guide/markdown.mdx really contains this shape: a ```` block whose body
      // shows a ``` example. A parity toggle would leave the rest of the file
      // treated as code and silently stop checking its links.
      const source = ['````markdown', '```plantuml', 'A -> B', '```', '````', '[real](./storage)'].join('\n')

      assert.deepEqual(extractRelativeLinks(source), [{ href: './storage', line: 6 }])
    })

    it('does not let the other fence character close an open block', () => {
      const source = ['~~~md', '[sample](./not-a-page)', '```', '[still-code](./nope)', '~~~', '[real](./mail)'].join('\n')

      assert.deepEqual(extractRelativeLinks(source), [{ href: './mail', line: 6 }])
    })
  })

  describe('extractJsxHrefs', () => {
    it('collects the href attribute of a JSX element with its line number', () => {
      const source = ['<Cards>', '  <Card title="a" href="/ja/docs/guide/quickstart" />', "  <Card title='b' href='/ja/docs/operations' />", '</Cards>'].join('\n')

      assert.deepEqual(extractJsxHrefs(source), [
        { href: '/ja/docs/guide/quickstart', line: 2 },
        { href: '/ja/docs/operations', line: 3 },
      ])
    })

    it('ignores an href inside a fenced code block', () => {
      // A page that documents the card markup shows the attribute in a fence.
      // Checking it would flag a sample that is not a link on the rendered page.
      const source = ['<Card href="/ja/docs/guide/quickstart" />', '```mdx', '<Card href="/ja/docs/does-not-exist" />', '```'].join('\n')

      assert.deepEqual(extractJsxHrefs(source), [{ href: '/ja/docs/guide/quickstart', line: 1 }])
    })

    it('leaves markdown links alone — those are the relative-link checker\u2019s job', () => {
      assert.deepEqual(extractJsxHrefs('[storage](./storage)'), [])
    })
  })

  describe('resolveJsxHref', () => {
    const root = mkdtempSync(join(tmpdir(), 'crowi-docs-jsx-'))
    const docsRoot = join(root, DOCS_DIR)
    const localeRoot = join(docsRoot, 'ja')
    /** @type {Set<string>} */
    let pages

    before(() => {
      for (const locale of ['ja', 'en']) {
        mkdirSync(join(docsRoot, locale, 'operations'), { recursive: true })
        mkdirSync(join(docsRoot, locale, 'guide'), { recursive: true })
        writeFileSync(join(docsRoot, locale, 'index.mdx'), '')
        writeFileSync(join(docsRoot, locale, 'operations', 'index.mdx'), '')
        writeFileSync(join(docsRoot, locale, 'guide', 'quickstart.mdx'), '')
      }
      pages = new Set(collectDocsFiles(root))
    })

    after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('resolves a locale-absolute href to a page', () => {
      assert.deepEqual(resolveJsxHref('/ja/docs/guide/quickstart', localeRoot, pages), { ok: true })
    })

    // The card that opens a whole tab points at the folder, which index.mdx owns.
    it('resolves a folder href to the index page that owns the folder URL', () => {
      assert.deepEqual(resolveJsxHref('/ja/docs/operations', localeRoot, pages), { ok: true })
      assert.deepEqual(resolveJsxHref('/ja/docs', localeRoot, pages), { ok: true })
    })

    // The failure this check exists for: `Card` hands its href straight to the
    // link component, so it never passes through the relative-link resolver
    // that would have added the locale. A locale-less href 404s in production.
    it('rejects an href that dropped the locale segment', () => {
      const result = resolveJsxHref('/docs/guide/quickstart', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /\/ja\/docs/)
    })

    it('rejects an href that points into another locale', () => {
      const result = resolveJsxHref('/en/docs/guide/quickstart', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /\/ja\/docs/)
    })

    it('rejects an href whose page does not exist', () => {
      const result = resolveJsxHref('/ja/docs/reference/env', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /no such page/)
    })

    it('skips an external destination', () => {
      assert.deepEqual(resolveJsxHref('https://github.com/crowi/crowi', localeRoot, pages), { ok: true })
      assert.deepEqual(resolveJsxHref('mailto:hi@example.com', localeRoot, pages), { ok: true })
    })
  })

  describe('resolveLink', () => {
    const root = mkdtempSync(join(tmpdir(), 'crowi-docs-links-'))
    const localeRoot = join(root, DOCS_DIR, 'ja')
    const page = join(localeRoot, 'operations', 'storage.mdx')
    /** @type {Set<string>} */
    let pages

    before(() => {
      mkdirSync(join(localeRoot, 'operations'), { recursive: true })
      mkdirSync(join(localeRoot, 'guide'), { recursive: true })
      mkdirSync(join(localeRoot, 'develop'), { recursive: true })
      writeFileSync(join(localeRoot, 'index.mdx'), '')
      writeFileSync(join(localeRoot, 'operations', 'storage.mdx'), '')
      writeFileSync(join(localeRoot, 'operations', 'encryption.mdx'), '')
      writeFileSync(join(localeRoot, 'operations', 'index.mdx'), '')
      writeFileSync(join(localeRoot, 'guide', 'markdown.mdx'), '')
      writeFileSync(join(localeRoot, 'develop', 'index.mdx'), '')
      pages = new Set(collectDocsFiles(root))
    })

    after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('resolves siblings, other folders and folder index pages', () => {
      assert.deepEqual(resolveLink(page, './encryption', localeRoot, pages), { ok: true })
      assert.deepEqual(resolveLink(page, '../guide/markdown', localeRoot, pages), { ok: true })
      assert.deepEqual(resolveLink(page, '../develop', localeRoot, pages), { ok: true })
    })

    // `operations/index.mdx` is a real folder index: it owns the folder URL
    // while its siblings live inside the same directory. Both directions have
    // to resolve, and the folder-URL form is the only one that may be linked.
    it('resolves a link from a folder index to a sibling in the same folder', () => {
      const folderIndex = join(localeRoot, 'operations', 'index.mdx')

      assert.deepEqual(resolveLink(folderIndex, './encryption', localeRoot, pages), { ok: true })
      assert.deepEqual(resolveLink(folderIndex, '../guide/markdown', localeRoot, pages), { ok: true })
    })

    it('resolves a link to a folder index through its folder URL, from either depth', () => {
      const sibling = join(localeRoot, 'operations', 'encryption.mdx')
      const otherFolder = join(localeRoot, 'guide', 'markdown.mdx')

      assert.deepEqual(resolveLink(sibling, '../operations', localeRoot, pages), { ok: true })
      assert.deepEqual(resolveLink(otherFolder, '../operations', localeRoot, pages), { ok: true })
    })

    it('rejects linking a folder index by its file name', () => {
      const result = resolveLink(page, './index', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /folder URL/)
    })

    it('ignores the fragment when resolving', () => {
      assert.deepEqual(resolveLink(page, './encryption#鍵の生成', localeRoot, pages), { ok: true })
    })

    it('rejects an explicit .mdx destination because site URLs carry no extension', () => {
      const result = resolveLink(page, './encryption.mdx', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /no file extension/)
    })

    it('rejects a trailing index segment because index.mdx is served at its folder URL', () => {
      const result = resolveLink(page, '../index', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /folder URL/)
    })

    it('rejects a wrong-case destination even on a case-insensitive filesystem', () => {
      const result = resolveLink(page, './Encryption', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /no such page/)
    })

    it('reports a destination that has no page', () => {
      const result = resolveLink(page, '../plugins/managing', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /no such page/)
    })

    it('reports a destination that escapes the locale directory', () => {
      const result = resolveLink(page, '../../en/operations/storage', localeRoot, pages)

      assert.equal(result.ok, false)
      assert.match(result.reason, /resolves outside/)
    })
  })

  describe('collectDocsFiles and findBrokenLinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'crowi-docs-links-scan-'))

    before(() => {
      for (const locale of ['ja', 'en']) {
        mkdirSync(join(root, DOCS_DIR, locale, 'operations'), { recursive: true })
        writeFileSync(join(root, DOCS_DIR, locale, 'index.mdx'), '[ops](./operations/storage)\n')
        writeFileSync(join(root, DOCS_DIR, locale, 'operations', 'storage.mdx'), '[moved](../plugins/managing)\n[root](../index)\n')
      }
      mkdirSync(join(root, 'apps', 'crowi-site', 'src'), { recursive: true })
      writeFileSync(join(root, 'apps', 'crowi-site', 'src', 'ignored.mdx'), '[x](./nope)\n')
    })

    after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('collects pages from every locale directory only', () => {
      assert.deepEqual(collectDocsFiles(root), [
        join(root, DOCS_DIR, 'en', 'index.mdx'),
        join(root, DOCS_DIR, 'en', 'operations', 'storage.mdx'),
        join(root, DOCS_DIR, 'ja', 'index.mdx'),
        join(root, DOCS_DIR, 'ja', 'operations', 'storage.mdx'),
      ])
    })

    it('reports one violation per unresolved link and counts the checked links', () => {
      const { violations, checked } = findBrokenLinks(collectDocsFiles(root), root)

      assert.equal(checked, 6)
      assert.deepEqual(
        violations.map((violation) => `${violation.file}:${violation.line} ${violation.href}`),
        [
          `${join(DOCS_DIR, 'en', 'operations', 'storage.mdx')}:1 ../plugins/managing`,
          `${join(DOCS_DIR, 'en', 'operations', 'storage.mdx')}:2 ../index`,
          `${join(DOCS_DIR, 'ja', 'operations', 'storage.mdx')}:1 ../plugins/managing`,
          `${join(DOCS_DIR, 'ja', 'operations', 'storage.mdx')}:2 ../index`,
        ],
      )
    })
  })
})
