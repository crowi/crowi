// pipeline.workflow.js の駆動テスト。workflow スクリプトは top-level await と
// `return` を含むので import できない — AsyncFunction で構築し、label prefix で
// ディスパッチする fake agent を注入して driver を実走させる (書き写しではなく
// 実ソースを評価するので、コードとテストがズレない)。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pipeline.workflow.js')
const SOURCE = readFileSync(WORKFLOW, 'utf8').replace(/^export const meta =/m, 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function buildDriver() {
  return new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', SOURCE)
}

// label prefix -> handler。マッチしない呼び出しは記録して null (agent 死亡と同義)。
function fakeAgent(handlers, calls) {
  return async (prompt, opts = {}) => {
    calls.push({ prompt, label: opts.label || '', schema: opts.schema })
    for (const [prefix, handler] of handlers) {
      if ((opts.label || '').startsWith(prefix)) return typeof handler === 'function' ? handler(prompt, opts) : handler
    }
    return null
  }
}

const noop = () => {}
const runParallel = async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))

async function run(args, handlers) {
  const calls = []
  const driver = buildDriver()
  const result = await driver(JSON.stringify(args), fakeAgent(handlers, calls), runParallel, null, noop, noop, null, null)
  return { result, calls }
}

// 正常系で毎回使う「全部通る」ハンドラ群。fakeAgent は最初に一致した prefix で
// 確定する (Array.prototype.some のような早期確定) ので、上書きしたい呼び出し元は
// extra を先頭に置いて base より先にマッチさせる。
const happyHandlers = (extra = []) => [
  ...extra,
  ['validate-spec:', { ready: true, kind: 'leaf', detail: 'READY' }],
  ['plan:', { summary: 'planned' }],
  ['impl:', { ready: true, summary: 'implemented' }],
  ['polish:', { ready: true, summary: 'polished' }],
  ['simplify:', 'no change'],
  ['review:', { verdict: 'APPROVED', summary: 'ok', blocking: [], advisories: [] }],
  ['commit:', { committed: true, summary: 'committed', commitShas: ['abc1234'] }],
  ['metrics:', { recorded: true }],
]

test('malformed args JSON fails fast without running any agent', async () => {
  const calls = []
  const driver = buildDriver()
  const result = await driver('not json {', fakeAgent([], calls), runParallel, null, noop, noop, null, null)
  assert.equal(result.status, 'FAILED')
  assert.match(result.reason, /did not parse as JSON/)
  assert.equal(calls.length, 0, 'no agent may run on malformed args')
})

test('a phase without an explicit boolean autoContinue fails fast (the gate must not silently drop)', async () => {
  const { result, calls } = await run(
    { id: 'feature-x', phases: [{ id: 'a', title: 'A', autoContinue: true }, { id: 'b', title: 'B' }] },
    [],
  )
  assert.equal(result.status, 'FAILED')
  assert.match(result.reason, /autoContinue must be an explicit boolean/)
  assert.equal(calls.length, 0)
})

test('non-integer maxReviewAttempts fails fast', async () => {
  const { result, calls } = await run({ id: 'feature-x', maxReviewAttempts: 0 }, [])
  assert.equal(result.status, 'FAILED')
  assert.match(result.reason, /maxReviewAttempts/)
  assert.equal(calls.length, 0)
})

test('an id with shell metacharacters fails fast, before it ever reaches an unquoted Bash interpolation', async () => {
  for (const bad of ['feature x', "feature-x' ; rm -rf /", 'feature-$(whoami)', 'feature-x"y']) {
    const { result, calls } = await run({ id: bad }, [])
    assert.equal(result.status, 'FAILED', `id=${JSON.stringify(bad)} must be rejected`)
    assert.match(result.reason, /id must match/)
    assert.equal(calls.length, 0)
  }
})

test('v2 (needsPlanner=false) runs the validator itself and refuses a failed validation', async () => {
  const { result, calls } = await run({ id: 'feature-x', needsPlanner: false }, [
    ['validate-spec:', { ready: false, kind: 'leaf', detail: 'ERROR: spec is stale' }],
    ['metrics:', { recorded: true }],
  ])
  assert.equal(result.status, 'FAILED')
  assert.match(result.reason, /did not pass/)
  assert.match(result.reason, /stale/)
  assert.ok(calls.some((c) => c.label.startsWith('validate-spec:')), 'the pipeline must run the validator')
  assert.ok(!calls.some((c) => c.label.startsWith('impl:')), 'no implementation may start on a rejected claim')
})

test('an umbrella spec reaching needsPlanner=false is refused as a caller-routing bug (last-resort backstop; crowi-feature/SKILL.md 2.2 is supposed to route it to needsPlanner=true first)', async () => {
  const { result, calls } = await run({ id: 'feature-x', needsPlanner: false }, [
    ['validate-spec:', { ready: true, kind: 'umbrella', detail: 'READY' }],
    ['metrics:', { recorded: true }],
  ])
  assert.equal(result.status, 'FAILED')
  assert.match(result.reason, /umbrella/)
  assert.match(result.reason, /SKILL\.md 2\.2/, 'must point at the routing fix, not tell the caller to kick off sub-specs')
  assert.ok(!calls.some((c) => c.label.startsWith('impl:')))
})

test('a validator agent that cannot classify frontmatter kind (kind=unknown) is refused rather than silently treated as a leaf spec', async () => {
  const { result, calls } = await run({ id: 'feature-x', needsPlanner: false }, [
    ['validate-spec:', { ready: true, kind: 'unknown', detail: 'READY' }],
    ['metrics:', { recorded: true }],
  ])
  assert.equal(result.status, 'FAILED')
  assert.match(result.reason, /kind=unknown/)
  assert.ok(!calls.some((c) => c.label.startsWith('impl:')), 'an unclassifiable kind must not be treated as a leaf spec')
})

test('v2 leaf runs to DONE; legacy (default) skips the validator and runs the planner', async () => {
  const v2 = await run({ id: 'feature-x', needsPlanner: false }, happyHandlers())
  assert.equal(v2.result.status, 'DONE')
  assert.ok(v2.calls.some((c) => c.label.startsWith('validate-spec:')))
  assert.ok(!v2.calls.some((c) => c.label.startsWith('plan:')))

  const legacy = await run({ id: 'feature-x' }, happyHandlers())
  assert.equal(legacy.result.status, 'DONE')
  assert.ok(!legacy.calls.some((c) => c.label.startsWith('validate-spec:')), 'legacy path has no v2 claim to verify')
  assert.ok(legacy.calls.some((c) => c.label.startsWith('plan:')))
})

test('resume=true validates structure-only (staleness is expected after earlier phases)', async () => {
  const { calls } = await run({ id: 'feature-x', needsPlanner: false, resume: true }, happyHandlers())
  const validate = calls.find((c) => c.label.startsWith('validate-spec:'))
  assert.ok(validate)
  assert.match(validate.prompt, /--structure-only/)
})

test('metrics are recorded once at run close with quote-free payload, and a metrics failure never changes the result', async () => {
  const ok = await run({ id: 'feature-x', needsPlanner: false }, happyHandlers())
  const metricCalls = ok.calls.filter((c) => c.label.startsWith('metrics:'))
  assert.equal(metricCalls.length, 1)
  const dataMatch = metricCalls[0].prompt.match(/--data '([^']*)'/)
  assert.ok(dataMatch, 'payload must ride a single-quoted --data argument')
  const payload = JSON.parse(dataMatch[1])
  assert.equal(payload.workflow, 'crowi-feature-pipeline')
  assert.equal(payload.status, 'DONE')
  assert.ok(!dataMatch[1].includes("'"), 'payload must not contain a single quote')

  const returnsNull = await run({ id: 'feature-x', needsPlanner: false }, happyHandlers([['metrics:', () => null]]))
  assert.equal(returnsNull.result.status, 'DONE', 'a metrics agent returning null must not change the result')

  const throws = await run(
    { id: 'feature-x', needsPlanner: false },
    happyHandlers([
      [
        'metrics:',
        () => {
          throw new Error('agent transport failed')
        },
      ],
    ]),
  )
  assert.equal(throws.result.status, 'DONE', 'a metrics agent that throws must not change the result (best-effort by contract)')
})

test('a downstream gated phase returns GATED before running it, and metrics record the GATED status', async () => {
  const { result, calls } = await run(
    {
      id: 'feature-x',
      needsPlanner: false,
      phases: [
        { id: 'a', title: 'A', autoContinue: true },
        { id: 'b', title: 'B', autoContinue: false },
      ],
    },
    happyHandlers(),
  )
  assert.equal(result.status, 'GATED')
  assert.equal(result.gatedAt, 'b')
  assert.ok(!calls.some((c) => c.label.startsWith('impl:feature-x/b')), 'phase b must not start')
  const metric = calls.find((c) => c.label.startsWith('metrics:'))
  assert.match(metric.prompt, /"status":"GATED"/)
})
