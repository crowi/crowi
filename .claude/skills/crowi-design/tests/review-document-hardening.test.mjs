// review-document.workflow.js の縮退 fail-closed / preexisting 蓄積 / 構造化 findings の
// 駆動テスト。workflow は top-level await と `return` を含むので import できない —
// AsyncFunction で構築し、label でディスパッチする fake agent で driver を実走させる。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'review-document.workflow.js')
const SOURCE = readFileSync(WORKFLOW, 'utf8').replace(/^export const meta =/m, 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function fakeAgent(handlers, calls) {
  return async (prompt, opts = {}) => {
    calls.push({ prompt, label: opts.label || '' })
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
  const driver = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', SOURCE)
  const result = await driver(JSON.stringify(args), fakeAgent(handlers, calls), runParallel, null, noop, noop, null, null)
  return { result, calls }
}

const ok = (data) => ({ status: 'ok', data })
const review = (verdict, blocking = [], preexisting = []) => ({ verdict, blocking, preexisting, notes: null })
const REVIEW_ONLY_ARGS = { reviewOnly: true, docPath: 'some-spec.md', outputType: 'spec', slug: 'x', critical: true }
// spec + critical: lenses = root-cause / red-team / coverage / implementability + claude-critical (5 本)

test('healthy round: OK with structured findings and per-lens provenance', async () => {
  const { result } = await run(REVIEW_ONLY_ARGS, [
    ['codex:review_root-cause_1', ok(review('OK', [], ['p-shared']))],
    ['codex:review_red-team_1', ok(review('OK'))],
    ['codex:review_coverage_1', ok(review('OK'))],
    ['codex:review_implementability_1', ok(review('OK'))],
    ['review:x:claude-critical#1', review('OK')],
  ])
  assert.equal(result.status, 'OK')
  assert.deepEqual(result.preexisting, ['p-shared'])
  assert.deepEqual(result.findings, [{ lens: 'root-cause', category: 'preexisting', text: 'p-shared' }])
  assert.equal(result.reviewStats.lensesPlanned, 5)
  assert.equal(result.reviewStats.viaFallback, 0)
  assert.equal(result.reviewStats.deadLenses, 0, 'a mislabeled fake would silently kill a lens')
})

test('findings classify mustFix vs carryForward and dedup within a lens', async () => {
  const { result } = await run(REVIEW_ONLY_ARGS, [
    ['codex:review_root-cause_1', ok(review('ISSUES', ['b1', 'b1']))],
    ['codex:review_red-team_1', ok(review('OK'))],
    ['codex:review_coverage_1', ok(review('ISSUES', ['gap-1']))],
    ['codex:review_implementability_1', ok(review('OK'))],
    ['review:x:claude-critical#1', review('OK')],
  ])
  assert.equal(result.status, 'ISSUES')
  const mustFix = result.findings.filter((f) => f.category === 'mustFix')
  const carry = result.findings.filter((f) => f.category === 'carryForward')
  assert.deepEqual(mustFix, [{ lens: 'root-cause', category: 'mustFix', text: 'b1' }], 'duplicates collapse')
  assert.deepEqual(carry, [{ lens: 'coverage', category: 'carryForward', text: 'gap-1' }])
})

test('a round where 3+ lenses ran without an independent codex verdict is DEGRADED, not OK', async () => {
  const degradedHandlers = [
    ['codex:review_root-cause_1', { status: 'codex_unavailable' }],
    ['codex:review_red-team_1', { status: 'codex_unavailable' }],
    ['codex:review_coverage_1', { status: 'codex_unavailable' }],
    ['codex:review_implementability_1', ok(review('OK'))],
    // fallback (Claude) は 3 lens とも生きて OK を返す — それでも独立判定は 2 本しかない
    ['review:x:root-cause#1', review('OK')],
    ['review:x:red-team#1', review('OK')],
    ['review:x:coverage#1', review('OK')],
    ['review:x:claude-critical#1', review('OK')],
  ]
  const { result } = await run(REVIEW_ONLY_ARGS, degradedHandlers)
  assert.equal(result.status, 'DEGRADED')
  assert.equal(result.reason, 'codex_degraded_this_round')
  assert.equal(result.reviewStats.viaFallback, 3)
  assert.equal(result.reviewStats.deadLenses, 0)

  const accepted = await run({ ...REVIEW_ONLY_ARGS, acceptFallback: true }, degradedHandlers)
  assert.equal(accepted.result.status, 'OK', 'acceptFallback overrides fail-closed explicitly')
})

test('dead lenses (codex AND fallback both failed) count toward degradation', async () => {
  const { result } = await run(REVIEW_ONLY_ARGS, [
    // root-cause / red-team / coverage: glue も fallback も死ぬ (fake は未登録 label に null)
    ['codex:review_implementability_1', ok(review('OK'))],
    ['review:x:claude-critical#1', review('OK')],
  ])
  assert.equal(result.status, 'DEGRADED')
  assert.equal(result.reviewStats.deadLenses, 3)
  assert.equal(result.reviewStats.lensesReturned, 2)
})

test('claude-critical lens is classified by its underlying key, not forced mustFix by the claude- prefix (F10 regression)', async () => {
  // spec: claudeCriticalLens = lenses[1] = red-team, which IS in spec's MUST_FIX_LENSES — must stay mustFix.
  const { result: specResult } = await run(REVIEW_ONLY_ARGS, [
    ['codex:review_root-cause_1', ok(review('OK'))],
    ['codex:review_red-team_1', ok(review('OK'))],
    ['codex:review_coverage_1', ok(review('OK'))],
    ['codex:review_implementability_1', ok(review('OK'))],
    ['review:x:claude-critical#1', review('ISSUES', ['spec-claude-finding'])],
  ])
  const specFinding = specResult.findings.find((f) => f.text === 'spec-claude-finding')
  assert.equal(specFinding.lens, 'claude-red-team')
  assert.equal(specFinding.category, 'mustFix', 'red-team is mustFix for spec, so claude-red-team must stay mustFix')

  // rfc: claudeCriticalLens = lenses[1] = completeness, which is NOT in rfc's MUST_FIX_LENSES — must be carryForward.
  const RFC_REVIEW_ONLY_ARGS = { reviewOnly: true, docPath: 'some-rfc.md', outputType: 'rfc', slug: 'x', critical: true }
  const { result: rfcResult } = await run(RFC_REVIEW_ONLY_ARGS, [
    ['codex:review_approach_1', ok(review('OK'))],
    ['codex:review_completeness_1', ok(review('OK'))],
    ['codex:review_quality_1', ok(review('OK'))],
    ['review:x:claude-critical#1', review('ISSUES', ['rfc-claude-finding'])],
  ])
  const rfcFinding = rfcResult.findings.find((f) => f.text === 'rfc-claude-finding')
  assert.equal(rfcFinding.lens, 'claude-completeness')
  assert.equal(
    rfcFinding.category,
    'carryForward',
    'completeness is not mustFix for rfc, so claude-completeness must not be forced mustFix by the claude- prefix',
  )
})

test('write loop accumulates preexisting and findings across rounds (not just the final round)', async () => {
  const writeResult = ok({
    wrote: true,
    docPath: '.feature-state/specs/feature-x.md',
    rfcNumber: null,
    summary: 'wrote',
    blockedReason: null,
    residualOpenQuestions: [],
    rebutted: [],
  })
  const { result } = await run(
    { slug: 'x', title: 'X', outputType: 'spec', briefPath: 'brief.md', maxReviewAttempts: 2 },
    [
      ['codex:write', writeResult],
      // round 1: root-cause が blocking + preexisting p1 → revise へ
      ['codex:review_root-cause_1', ok(review('ISSUES', ['fix-me'], ['p1']))],
      ['codex:review_red-team_1', ok(review('OK'))],
      ['codex:review_coverage_1', ok(review('OK'))],
      ['codex:review_implementability_1', ok(review('OK'))],
      ['codex:revise_1', writeResult],
      // round 2: 全部 OK・red-team が p2 を報告 → APPROVED
      ['codex:review_root-cause_2', ok(review('OK'))],
      ['codex:review_red-team_2', ok(review('OK', [], ['p2']))],
      ['codex:review_coverage_2', ok(review('OK'))],
      ['codex:review_implementability_2', ok(review('OK'))],
      ['finalize:x', { ready: true, blockedReason: null }],
    ],
  )
  assert.equal(result.status, 'DONE')
  assert.deepEqual(result.preexisting.sort(), ['p1', 'p2'], 'round-1 preexisting must survive to the end')
  assert.ok(result.findings.some((f) => f.category === 'mustFix' && f.text === 'fix-me'))
  assert.ok(result.findings.some((f) => f.category === 'preexisting' && f.text === 'p1'))
  assert.ok(result.findings.some((f) => f.category === 'preexisting' && f.text === 'p2'))
})
