// Unit tests for scripts/dev-portal/index.mjs's two pure functions. Run with
// `node --test` (see dev-ports.test.mjs for the rationale). `parseWorktreeList`
// (parses `git worktree list --porcelain`) and `renderPortalHtml` (escapes
// user-controlled strings into one static HTML page) are exactly the
// "pure functions exported + testable" the task's architecturalNotes calls
// for — everything else in that module is either a `git`/`http` side effect
// (`listLiveWorktrees`, `probeProxyUp`) or the already-covered registry code
// in `dev-ports.mjs`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseWorktreeList, renderPortalHtml } from './dev-portal/index.mjs'

describe('parseWorktreeList', () => {
  it('parses multiple worktree blocks, stripping the refs/heads/ prefix from branch', () => {
    const porcelain = [
      'worktree /Volumes/working/crowi/crowi',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Volumes/working/crowi/crowi-feature-foo',
      'HEAD def456',
      'branch refs/heads/feature-foo/impl',
      '',
    ].join('\n')

    assert.deepEqual(parseWorktreeList(porcelain), [
      { dir: '/Volumes/working/crowi/crowi', branch: 'main' },
      { dir: '/Volumes/working/crowi/crowi-feature-foo', branch: 'feature-foo/impl' },
    ])
  })

  it('reports branch: null for a detached-HEAD worktree (no branch line)', () => {
    const porcelain = 'worktree /Volumes/working/crowi/crowi-detached\nHEAD abc123\ndetached\n'
    assert.deepEqual(parseWorktreeList(porcelain), [{ dir: '/Volumes/working/crowi/crowi-detached', branch: null }])
  })

  it('drops blocks with no worktree line', () => {
    assert.deepEqual(parseWorktreeList('\n\n   \n\n'), [])
  })

  it('handles a single trailing block with no trailing blank line', () => {
    const porcelain = 'worktree /Volumes/working/crowi/crowi\nHEAD abc123\nbranch refs/heads/main'
    assert.deepEqual(parseWorktreeList(porcelain), [{ dir: '/Volumes/working/crowi/crowi', branch: 'main' }])
  })

  // Regression: a worktree removed via `rm -rf` (instead of `git worktree
  // remove`) lingers in `git worktree list --porcelain`, annotated
  // `prunable ...`, until `git worktree prune` runs. It must be excluded here
  // so its registry entry actually gets GC'd instead of reserving its anchor
  // block forever (see `pruneRegistry` in `../dev-ports.mjs`).
  it('drops a prunable worktree (directory removed without `git worktree remove`)', () => {
    const porcelain = [
      'worktree /Volumes/working/crowi/crowi',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Volumes/working/crowi/crowi-gone',
      'HEAD def456',
      'branch refs/heads/gone-branch',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')

    assert.deepEqual(parseWorktreeList(porcelain), [{ dir: '/Volumes/working/crowi/crowi', branch: 'main' }])
  })
})

describe('renderPortalHtml', () => {
  it('renders "No worktrees found." when there are no rows', () => {
    const html = renderPortalHtml([])
    assert.match(html, /No worktrees found\./)
    assert.doesNotMatch(html, /class="wt"/)
  })

  it('escapes HTML-significant characters in every string field', () => {
    const rows = [
      {
        key: '<script>alert(1)</script>',
        branch: 'feature/"quoted"&branch',
        anchor: 4310,
        up: true,
        localUrl: 'http://localhost:4313/?x=<y>',
        tailscaleUrl: null,
        db: "crowi_<isolated>&'x'",
      },
    ]
    const html = renderPortalHtml(rows)
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear unescaped')
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assert.match(html, /feature\/&quot;quoted&quot;&amp;branch/)
    assert.match(html, /crowi_&lt;isolated&gt;&amp;&#39;x&#39;/)
    // The URL text node is escaped too, not just the href attribute value.
    assert.match(html, /href="http:\/\/localhost:4313\/\?x=&lt;y&gt;"/)
  })

  it('shows up/down/not-started status based on anchor + up', () => {
    const rows = [
      { key: 'a', branch: 'main', anchor: null, up: false, localUrl: null, tailscaleUrl: null, db: 'shared (main)' },
      { key: 'b', branch: 'main', anchor: 4310, up: true, localUrl: 'http://localhost:4313/', tailscaleUrl: null, db: 'shared (main)' },
      { key: 'c', branch: 'main', anchor: 4320, up: false, localUrl: 'http://localhost:4323/', tailscaleUrl: null, db: 'shared (main)' },
    ]
    const html = renderPortalHtml(rows)
    assert.match(html, /not started/)
    assert.match(html, /🟢 up/)
    assert.match(html, /🔴 down/)
  })

  it('renders reachable IP URLs (Model B) as tappable links', () => {
    const rows = [
      {
        key: 'main',
        branch: 'main',
        anchor: 4301,
        up: true,
        localUrl: 'http://localhost:4304/',
        ipUrls: ['http://100.83.129.55:4304/', 'http://10.0.3.109:4304/'],
        tailscaleUrl: null,
        db: 'shared (main)',
      },
    ]
    const html = renderPortalHtml(rows)
    assert.match(html, /href="http:\/\/100\.83\.129\.55:4304\/"/)
    assert.match(html, /href="http:\/\/10\.0\.3\.109:4304\/"/)
  })

  it('always shows the localhost link, and lists the tailscale URL when present', () => {
    const rows = [
      { key: 'a', branch: null, anchor: 4310, up: true, localUrl: 'http://localhost:4313/', ipUrls: [], tailscaleUrl: null, db: 'shared (main)' },
      {
        key: 'b',
        branch: null,
        anchor: 4320,
        up: true,
        localUrl: 'http://localhost:4323/',
        ipUrls: [],
        tailscaleUrl: 'https://my-mac.tailnet.ts.net:4323/',
        db: 'shared (main)',
      },
    ]
    const html = renderPortalHtml(rows)
    assert.match(html, /href="http:\/\/localhost:4313\/"/)
    assert.match(html, /href="https:\/\/my-mac\.tailnet\.ts\.net:4323\/"/)
  })

  it('renders a not-started worktree without links, prompting to run pnpm dev', () => {
    const html = renderPortalHtml([
      { key: 'idle-wt', branch: 'idle/impl', anchor: null, up: false, localUrl: null, ipUrls: [], tailscaleUrl: null, db: 'shared (main)' },
    ])
    assert.match(html, /not started/)
    assert.match(html, /pnpm dev/)
    assert.doesNotMatch(html, /class="link"/)
  })

  it('preserves the given row order (main-first is the caller’s sort responsibility)', () => {
    const rows = [
      { key: 'main', branch: 'main', anchor: 4301, up: true, localUrl: 'http://localhost:4304/', tailscaleUrl: null, db: 'shared (main)' },
      { key: 'feature-a', branch: 'feature-a', anchor: 4310, up: true, localUrl: 'http://localhost:4313/', tailscaleUrl: null, db: 'shared (main)' },
    ]
    const html = renderPortalHtml(rows)
    assert.ok(html.indexOf('>main<') < html.indexOf('>feature-a<'), 'main row must come before feature-a in the rendered order')
  })
})
