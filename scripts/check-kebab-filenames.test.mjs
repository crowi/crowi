import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  collectSourceFiles,
  findViolations,
  firstSegment,
  isAllowedFilename,
  toKebab,
} from './check-kebab-filenames.mjs'

describe('check-kebab-filenames', () => {
  it('checks only the first segment of compound source filenames', () => {
    assert.equal(firstSegment('page-preview.smoke.test.ts'), 'page-preview')
    assert.equal(isAllowedFilename('page-preview.smoke.test.ts'), true)
    assert.equal(isAllowedFilename('next.config.ts'), true)
  })

  it('accepts kebab-case and intentional underscore-prefixed filenames', () => {
    assert.equal(isAllowedFilename('access-token.ts'), true)
    assert.equal(isAllowedFilename('user.ts'), true)
    assert.equal(isAllowedFilename('_pager.ts'), true)
    assert.equal(isAllowedFilename('_mdast-walk.ts'), true)
  })

  it('rejects PascalCase, lowerCamelCase, snake_case, and invalid underscore names', () => {
    assert.equal(isAllowedFilename('MarkdownEditor.tsx'), false)
    assert.equal(isAllowedFilename('tokenAuth.ts'), false)
    assert.equal(isAllowedFilename('token_auth.ts'), false)
    assert.equal(isAllowedFilename('_TokenAuth.ts'), false)
  })

  it('suggests a kebab-case replacement', () => {
    assert.equal(toKebab('MarkdownEditor'), 'markdown-editor')
    assert.equal(toKebab('tokenAuth'), 'token-auth')
    assert.equal(toKebab('token_auth'), 'token-auth')

    assert.deepEqual(findViolations(['/repo/apps/web/src/MarkdownEditor.test.tsx']), [
      {
        file: '/repo/apps/web/src/MarkdownEditor.test.tsx',
        basename: 'MarkdownEditor.test.tsx',
        suggested: 'markdown-editor.test.tsx',
      },
    ])
  })

  describe('collectSourceFiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'crowi-filename-check-'))

    after(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('collects TypeScript files from apps and packages but skips generated trees', () => {
      mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true })
      mkdirSync(join(root, 'packages', 'api', 'src', 'generated'), {
        recursive: true,
      })
      mkdirSync(join(root, 'outside'), { recursive: true })
      writeFileSync(join(root, 'apps', 'web', 'src', 'site-brand.tsx'), '')
      writeFileSync(join(root, 'packages', 'api', 'src', 'token-auth.ts'), '')
      writeFileSync(
        join(root, 'packages', 'api', 'src', 'generated', 'OpenAPI.ts'),
        '',
      )
      writeFileSync(join(root, 'outside', 'Ignored.ts'), '')

      const files = collectSourceFiles(root)

      assert.deepEqual(files, [
        join(root, 'apps', 'web', 'src', 'site-brand.tsx'),
        join(root, 'packages', 'api', 'src', 'token-auth.ts'),
      ])
    })
  })
})
