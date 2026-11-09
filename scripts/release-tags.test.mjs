import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { imageRefsFor, tagsFor, unstableImageRefsFor, unstableTagsFor } from './release-tags.mjs'

const SCRIPT = fileURLToPath(new URL('./release-tags.mjs', import.meta.url))
const SHA = '980edb028c1f2a3b4d5e6f708192a3b4c5d6e7f8'

test('a prerelease tags the exact version and its channel, never latest', () => {
  assert.deepEqual(tagsFor('v2.0.0-alpha.28', 'full'), ['2.0.0-alpha.28', 'alpha'])
  assert.deepEqual(tagsFor('v2.0.0-alpha.28', 'slim'), ['2.0.0-alpha.28-slim', 'alpha-slim'])
})

test('a stable version moves latest', () => {
  assert.deepEqual(tagsFor('v2.0.0.0', 'full'), ['2.0.0.0', 'latest'])
})

test('an unstable build tags the moving unstable tag and the short sha', () => {
  assert.deepEqual(unstableTagsFor(SHA, 'full'), ['unstable', 'unstable-980edb0'])
  assert.deepEqual(unstableTagsFor(SHA, 'slim'), ['unstable-slim', 'unstable-980edb0-slim'])
  assert.deepEqual(unstableImageRefsFor('crowi/crowi-web', SHA, 'full'), [
    'crowi/crowi-web:unstable',
    'crowi/crowi-web:unstable-980edb0',
  ])
})

test('unstable tags never overlap a release tag', () => {
  const release = new Set([...tagsFor('v2.0.0-alpha.28', 'full'), ...tagsFor('v2.0.0.0', 'full')])
  for (const t of unstableTagsFor(SHA, 'full')) assert.equal(release.has(t), false, t)
})

test('an unstable build rejects anything that is not a commit sha', () => {
  assert.throws(() => unstableTagsFor('main', 'full'), /invalid commit sha/)
  assert.throws(() => unstableTagsFor('', 'full'), /invalid commit sha/)
})

test('the CLI prints release refs or unstable refs, and needs exactly one of them', () => {
  const run = (...args) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
  assert.equal(
    run('--image', 'crowi/crowi', '--dist-version', 'v2.0.0-alpha.28', '--variant', 'slim'),
    `${imageRefsFor('crowi/crowi', 'v2.0.0-alpha.28', 'slim').join('\n')}\n`,
  )
  assert.equal(
    run('--image', 'crowi/crowi', '--unstable-sha', SHA, '--variant', 'full'),
    'crowi/crowi:unstable\ncrowi/crowi:unstable-980edb0\n',
  )
  assert.throws(() => run('--image', 'crowi/crowi', '--variant', 'full'), { status: 1 })
  assert.throws(() => run('--dist-version', 'v2.0.0-alpha.28', '--unstable-sha', SHA), { status: 1 })
})
