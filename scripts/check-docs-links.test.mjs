import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { collectDocsFiles, extractRelativeLinks, findBrokenLinks, resolveLink } from './check-docs-links.mjs'

const DOCS_DIR = join('apps', 'crowi-site', 'content', 'docs')

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
  })

  describe('resolveLink', () => {
    const root = mkdtempSync(join(tmpdir(), 'crowi-docs-links-'))
    const localeRoot = join(root, DOCS_DIR, 'ja')
    const page = join(localeRoot, 'operations', 'storage.mdx')

    before(() => {
      mkdirSync(join(localeRoot, 'operations'), { recursive: true })
      mkdirSync(join(localeRoot, 'guide'), { recursive: true })
      mkdirSync(join(localeRoot, 'develop'), { recursive: true })
      writeFileSync(join(localeRoot, 'index.mdx'), '')
      writeFileSync(join(localeRoot, 'operations', 'storage.mdx'), '')
      writeFileSync(join(localeRoot, 'operations', 'encryption.mdx'), '')
      writeFileSync(join(localeRoot, 'guide', 'markdown.mdx'), '')
      writeFileSync(join(root, DOCS_DIR, 'ja', 'develop', 'index.mdx'), '')
    })

    after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('resolves siblings, other folders and folder index pages', () => {
      assert.deepEqual(resolveLink(page, './encryption', localeRoot), { ok: true })
      assert.deepEqual(resolveLink(page, '../guide/markdown', localeRoot), { ok: true })
      assert.deepEqual(resolveLink(page, '../develop', localeRoot), { ok: true })
      assert.deepEqual(resolveLink(page, '../index', localeRoot), { ok: true })
    })

    it('ignores the fragment when resolving', () => {
      assert.deepEqual(resolveLink(page, './encryption#鍵の生成', localeRoot), { ok: true })
    })

    it('accepts an explicit .mdx destination', () => {
      assert.deepEqual(resolveLink(page, './encryption.mdx', localeRoot), { ok: true })
      assert.equal(resolveLink(page, './gone.mdx', localeRoot).ok, false)
    })

    it('reports a destination that has no page', () => {
      const result = resolveLink(page, '../plugins/managing', localeRoot)

      assert.equal(result.ok, false)
      assert.match(result.reason, /no such page/)
    })

    it('reports a destination that escapes the locale directory', () => {
      const result = resolveLink(page, '../../en/operations/storage', localeRoot)

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
        [`${join(DOCS_DIR, 'en', 'operations', 'storage.mdx')}:1 ../plugins/managing`, `${join(DOCS_DIR, 'ja', 'operations', 'storage.mdx')}:1 ../plugins/managing`],
      )
    })
  })
})
