// claude-md-drift.test.mjs — skill / agent ドキュメントが CLAUDE.md の節を prose 要約して
// いる箇所の drift guard。要約の内容一致は機械照合できないが、「要約元の節が rename /
// 削除されたのに要約だけ残る」という最も危険な drift は、要約側が宣言した出典見出しの
// 実在を検証するだけで捕まえられる。
//
// 自己登録式: CLAUDE.md を要約するファイルは frontmatter 直後に
//   <!-- drift-guard: CLAUDE.md heading "### <見出し行そのまま>" -->
// を要約元 1 節につき 1 行書く。この test が .claude/**/*.md を走査し、宣言された
// 見出しが CLAUDE.md に verbatim 存在することを検証する。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md')
const MARKER_RE = /<!--\s*drift-guard:\s*CLAUDE\.md heading\s*"((?:[^"\\]|\\.)+)"\s*-->/g

// 要約ファイルがマーカーごと消える meta-drift を防ぐ床: この 2 ファイルは
// CLAUDE.md の運用規約を要約していることが分かっているので、宣言ゼロは失敗にする。
const KNOWN_SUMMARIZERS = ['.claude/agents/feature-committer.md', '.claude/skills/crowi-role-manager/SKILL.md']

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkMarkdown(full, out)
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

function markersIn(file) {
  const src = readFileSync(file, 'utf8')
  const found = []
  for (const m of src.matchAll(MARKER_RE)) found.push(m[1].replace(/\\(.)/g, '$1'))
  return found
}

test('every declared drift-guard heading exists verbatim in CLAUDE.md', () => {
  const headings = new Set(
    readFileSync(CLAUDE_MD, 'utf8')
      .split('\n')
      .filter((l) => /^#{2,3} /.test(l)),
  )
  const files = walkMarkdown(path.join(REPO_ROOT, '.claude'))
  let declared = 0
  for (const file of files) {
    for (const heading of markersIn(file)) {
      declared++
      assert.ok(
        headings.has(heading),
        `${path.relative(REPO_ROOT, file)} summarizes CLAUDE.md section ${JSON.stringify(heading)}, ` +
          `but no such heading exists in CLAUDE.md — the section was renamed or removed, so the summary must follow.`,
      )
    }
  }
  assert.ok(declared > 0, 'no drift-guard markers found anywhere under .claude/ — the guard has gone dead')
})

test('the known CLAUDE.md summarizers still declare their sources', () => {
  for (const rel of KNOWN_SUMMARIZERS) {
    const found = markersIn(path.join(REPO_ROOT, rel))
    assert.ok(found.length > 0, `${rel} summarizes CLAUDE.md sections but declares no drift-guard markers`)
  }
})
