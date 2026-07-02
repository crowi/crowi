export const meta = {
  name: 'crowi-feature-pipeline',
  description:
    'Deterministic crowi-feature pipeline. Per phase: plan → implement → (simplify) → review-loop → commit. Multi-phase aware with autoContinue gating. Reuses the feature-{planner,implementer,reviewer,committer} agents via agentType; the control flow (sequencing, NEEDS_WORK retry, phase iteration, gates) is code, so the "narrate the next step then stop" failure mode is structurally impossible. With codexReviewer=true the review stage runs objective gates first (fail → NEEDS_WORK without spending any model tokens) and then a codex adversarial review through a thin haiku glue; feature-reviewer remains the fallback.',
  phases: [
    { title: 'Plan', detail: 'feature-planner fills task context + AC + commitPlan (scope-gated)' },
    { title: 'Build', detail: 'feature-implementer: code + tests + crowi-site docs, required checks must pass' },
    { title: 'Review', detail: 'simplify pass + reviewer (objective gates → codex, or feature-reviewer); loop back to Build on NEEDS_WORK' },
    { title: 'Commit', detail: 'feature-committer: split commits per commitPlan, main-direct, no push' },
  ],
}

// ----------------------------------------------------------------------------
// args — the crowi-feature SKILL fills these AFTER the (single) human gate:
//   spec approval + scope/config read + multi-phase extraction. Workflow
//   scripts have no filesystem access, so all control inputs arrive via args;
//   the agents themselves read/write .feature-state/specs|tasks/*.
//
//   {
//     id: 'feature-xxx',
//     needsPlanner: boolean,                 // scope > config.minScopeSize
//     runSimplify: boolean,                  // config.runSimplify
//     maxReviewAttempts: number,             // config.maxReviewAttempts (default 3)
//     codexReviewer: boolean,                // config.codexReviewer (default false):
//                                            // review = objective gates + codex,
//                                            // feature-reviewer as fallback
//     phases: [{ id, title, autoContinue }]  // from the resume point onward;
//                                            // single-phase => [{ id:'main', ... }]
//   }
// ----------------------------------------------------------------------------
// NOTE: in this runtime the workflow `args` input arrives as a JSON STRING
// (typeof args === 'string'), NOT a parsed object. Reading args.id directly
// yields undefined and would run a planner on task "undefined". Always parse.
function parseArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a === 'string' && a.trim()) {
    try {
      return JSON.parse(a)
    } catch {
      return {}
    }
  }
  return {}
}
const A = parseArgs(args)
const ID = A.id
const NEEDS_PLANNER = A.needsPlanner !== false
const RUN_SIMPLIFY = A.runSimplify !== false
const MAX_REVIEW = A.maxReviewAttempts ?? 3
const CODEX_REVIEWER = A.codexReviewer === true
const PHASES =
  Array.isArray(A.phases) && A.phases.length ? A.phases : [{ id: 'main', title: ID, autoContinue: true }]

// Fail fast before any agent runs: a missing id must not fall through.
if (!ID) {
  return { status: 'FAILED', reason: `crowi-feature pipeline: missing required arg id (got: ${JSON.stringify(A)})` }
}

// Structured returns so the script branches on data, not on prose / magic strings.
const IMPL_RESULT = {
  type: 'object',
  required: ['ready', 'summary'],
  additionalProperties: true,
  properties: {
    ready: {
      type: 'boolean',
      description:
        'true when the implementation is complete AND every required check (type-check / test / lint / format) passes; false when a required check cannot be made to pass or the spec is too ambiguous to proceed (explain in blockedReason).',
    },
    blockedReason: { type: 'string' },
    summary: { type: 'string' },
  },
}
const VERDICT = {
  type: 'object',
  required: ['verdict', 'summary'],
  additionalProperties: true,
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'NEEDS_WORK', 'ESCALATE'] },
    summary: { type: 'string' },
    blocking: { type: 'array', items: { type: 'string' } },
    // Non-blocking improvements. autofix=true → an implementer polish pass fixes
    // them before commit (the default — never defer to a TODO); autofix=false →
    // genuinely out-of-scope, surfaced to the human in the run summary.
    advisories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'autofix'],
        additionalProperties: true,
        properties: { description: { type: 'string' }, autofix: { type: 'boolean' } },
      },
    },
  },
}
const COMMIT_RESULT = {
  type: 'object',
  required: ['committed', 'summary'],
  additionalProperties: true,
  properties: {
    committed: { type: 'boolean' },
    summary: { type: 'string' },
    commitShas: { type: 'array', items: { type: 'string' } },
    needsHuman: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

const isMulti = (p) => p.id && p.id !== 'main'
const tag = (p) => (isMulti(p) ? ` (phase ${p.id}: ${p.title})` : '')
const suffix = (p) => (isMulti(p) ? `/${p.id}` : '')

// ----------------------------------------------------------------------------
// codex reviewer (spec feature-codex-role-split §10, gated by args.codexReviewer)
// A thin haiku glue runs the objective gates FIRST (a failed gate returns
// NEEDS_WORK without ever invoking codex — near-zero tokens, fully reliable),
// then a codex adversarial review of the uncommitted diff via codex-run.sh,
// records reviewFeedback on the task, and returns the VERDICT. Any glue/codex
// failure falls back to the original feature-reviewer agent (kept verbatim).
// The VERDICT schema for codex is OpenAI-strict (additionalProperties:false,
// all-required) — codex 400s otherwise.
// ----------------------------------------------------------------------------
const FALLBACKS = []
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
const VERDICT_STRICT = {
  type: 'object',
  required: ['verdict', 'summary', 'blocking', 'advisories'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'NEEDS_WORK', 'ESCALATE'] },
    summary: { type: 'string' },
    blocking: { type: 'array', items: { type: 'string' } },
    advisories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'autofix'],
        additionalProperties: false,
        properties: { description: { type: 'string' }, autofix: { type: 'boolean' } },
      },
    },
  },
}
const envelope = (dataSchema) => ({
  type: 'object',
  required: ['status'],
  additionalProperties: true,
  properties: {
    status: { type: 'string', enum: ['ok', 'codex_unavailable', 'invalid_output'] },
    data: dataSchema,
    note: { type: 'string' },
  },
})

function codexReviewerPrompt(p, attempt) {
  const runDir = `.reviews/codex-runs/${sanitize(ID)}/review_${sanitize(p.id)}_${attempt}`
  return (
    `You are a MECHANICAL REVIEW RUNNER for crowi-feature task "${ID}"${tag(p)} (attempt ` +
    `${attempt}/${MAX_REVIEW}). Follow the steps EXACTLY in order. Do NOT review or fix any code ` +
    `yourself — your only judgments are pass/fail of commands and copying data.\n\n` +
    `STEP 1 — objective gates. Run each with Bash from the repo root, in order (generous timeouts):\n` +
    `  (a) if \`git diff --name-only HEAD\` touches packages/api-contract/: ` +
    `pnpm --filter @crowi/api-contract build && pnpm check:openapi\n` +
    `  (b) pnpm --filter @crowi/api type-check\n` +
    `  (c) if the diff touches packages/web/: pnpm --filter @crowi/web type-check\n` +
    `  (d) pnpm --filter @crowi/api test\n` +
    `  (e) pnpm lint   (errors must be 0; warnings tolerated)\n` +
    `If ANY gate fails: do NOT run codex. Your verdict is ` +
    `{verdict:"NEEDS_WORK", summary:"objective gates failed", blocking:[one entry per failed gate: ` +
    `the command + the key error lines], advisories:[]} — go directly to STEP 4.\n\n` +
    `STEP 2 — build the review prompt (only when every gate passed):\n` +
    `  Read .feature-state/tasks/${ID}.json and extract: the acceptance criteria` +
    `${isMulti(p) ? ` for phase ${p.id}` : ''}, context.docsTargets, and the most recent ` +
    `reviewFeedback if present. Also read the "## 設計の主な判断" section of ` +
    `.feature-state/specs/${ID}.md if that file exists.\n` +
    `  Write ${runDir}/prompt.md: instructions for an adversarial review of the UNCOMMITTED diff — ` +
    `verify every acceptance criterion (embed the AC list verbatim), api-contract integrity, ` +
    `security, transaction boundaries, and crowi-site docs reflection when docsTargets is set ` +
    `(embed docsTargets + the design judgments verbatim). Ask for verdict APPROVED (all AC met, ` +
    `quality bar passes) / NEEDS_WORK (fixable issues; list them in blocking[]) / ESCALATE (only ` +
    `when a human design decision is genuinely required), plus advisories[] — non-blocking ` +
    `improvements each tagged autofix true (in-scope/mechanical, the default) or false (genuinely ` +
    `out-of-scope). Lean autofix.\n` +
    `  Write ${runDir}/schema.json with the SCHEMA block below.\n\n` +
    `STEP 3 — run codex with Bash (set timeout to 600000ms):\n` +
    `  bash .claude/scripts/codex-run.sh --mode review --review-target "--uncommitted" ` +
    `--prompt-file ${runDir}/prompt.md --schema-file ${runDir}/schema.json ` +
    `--out ${runDir}/out.json --label review-${sanitize(ID)}\n` +
    `  - exit 0 -> your verdict is the JSON in ${runDir}/out.json\n` +
    `  - exit 2, or the Bash call errors / times out -> return {status:"codex_unavailable", ` +
    `note:<last line of ${runDir}/out.json.stderr>} and STOP (skip STEP 4)\n` +
    `  - exit 3 -> return {status:"invalid_output", note:<same>} and STOP (skip STEP 4)\n\n` +
    `STEP 4 — record + return (only when you hold a verdict from STEP 1 or STEP 3):\n` +
    `  Update .feature-state/tasks/${ID}.json: set reviewFeedback = {attempt: ${attempt}, ` +
    `by: "gates"|"codex", at: <current UTC time from \`date -u +%FT%TZ\`>, verdict, summary, ` +
    `blocking, advisories}${isMulti(p) ? ` on the phases[] entry with id "${p.id}"` : ''} and append ` +
    `a matching history entry. Write atomically: write the full JSON to ` +
    `.feature-state/tasks/${ID}.json.tmp with Write, then \`mv\` it over the original with Bash.\n` +
    `  Return {status:"ok", data:<the verdict JSON>}.\n\n` +
    `SCHEMA:\n<<<\n${JSON.stringify(VERDICT_STRICT)}\n>>>`
  )
}

// One full phase cycle: plan? → (implement → simplify? → review)* → commit.
async function runPhase(p) {
  const t = tag(p)

  if (NEEDS_PLANNER) {
    phase('Plan')
    const planned = await agent(
      `crowi-feature PLANNER for task "${ID}"${t}. Read .feature-state/specs/${ID}.md and ` +
        `.feature-state/tasks/${ID}.json (create it if missing). Grep the codebase for reuse ` +
        `candidates and fill context.reuseTargets / newFiles / models / docsTargets / ` +
        `acceptanceCriteria / commitPlan${isMulti(p) ? ` for ${p.id} only` : ''}, then set the ` +
        `task/phase status. Follow your agent instructions exactly. Return a short summary.`,
      { agentType: 'feature-planner', label: `plan:${ID}${suffix(p)}` },
    )
    if (planned === null) return { ok: false, needsHuman: true, reason: 'planner did not complete' }
  }

  let verdict = null
  for (let attempt = 1; attempt <= MAX_REVIEW; attempt++) {
    phase('Build')
    const impl = await agent(
      `crowi-feature IMPLEMENTER for task "${ID}"${t} (attempt ${attempt}/${MAX_REVIEW}). Read ` +
        `.feature-state/tasks/${ID}.json. Implement the code + tests + crowi-site docs (ja/en) per ` +
        `the task. Run type-check / test / lint / format — they MUST all pass. Fill/refresh ` +
        `commitPlan and set status REVIEW. ` +
        (attempt > 1 ? 'Address the reviewer NEEDS_WORK feedback recorded on the task. ' : '') +
        `Set ready=false ONLY if a required check cannot be made to pass or the spec is too ` +
        `ambiguous to proceed (and put the reason in blockedReason).`,
      { agentType: 'feature-implementer', label: `impl:${ID}${suffix(p)}#${attempt}`, schema: IMPL_RESULT },
    )
    if (impl === null) return { ok: false, needsHuman: true, reason: 'implementer did not complete' }
    if (!impl.ready) return { ok: false, needsHuman: true, reason: impl.blockedReason || impl.summary || 'implementer blocked' }

    if (RUN_SIMPLIFY) {
      phase('Review')
      await agent(
        `crowi-feature SIMPLIFY pass for task "${ID}"${t}. Review the most recent uncommitted diff for ` +
          `reuse / simplification / efficiency / altitude and apply ONLY low-risk cleanups in place ` +
          `(no behaviour change, no bug-hunting — that is the reviewer's job). Keep all required checks ` +
          `green. Return a one-line summary of what changed (or "no change").`,
        { label: `simplify:${ID}${suffix(p)}#${attempt}` },
      )
    }

    phase('Review')
    const claudeReview = () =>
      agent(
        `crowi-feature REVIEWER for task "${ID}"${t} (attempt ${attempt}/${MAX_REVIEW}). Read ` +
          `.feature-state/tasks/${ID}.json + the uncommitted diff. Verify acceptance criteria` +
          `${isMulti(p) ? ` for ${p.id}` : ''}, api-contract integrity, security, transaction ` +
          `boundaries, and crowi-site docs reflection (when docsTargets is set). Record concrete ` +
          `NEEDS_WORK feedback on the task when not approving. Return your verdict: APPROVED when all AC ` +
          `are met and the quality bar passes; NEEDS_WORK when fixable issues remain; ESCALATE only when ` +
          `a human design decision is genuinely required. Also return advisories[] — non-blocking ` +
          `improvements each tagged autofix (in-scope / mechanical → fixed before commit, the default) or ` +
          `defer (genuinely out-of-scope → surfaced to the human, NOT written to any TODO). Lean autofix.`,
        { agentType: 'feature-reviewer', label: `review:${ID}${suffix(p)}#${attempt}`, schema: VERDICT },
      )
    if (CODEX_REVIEWER) {
      const glue = await agent(codexReviewerPrompt(p, attempt), {
        model: 'haiku',
        effort: 'low',
        schema: envelope(VERDICT_STRICT),
        label: `codex:review:${ID}${suffix(p)}#${attempt}`,
        phase: 'Review',
      })
      if (glue && glue.status === 'ok' && glue.data) {
        verdict = glue.data
      } else {
        const why = glue ? `${glue.status}${glue.note ? ` (${glue.note})` : ''}` : 'glue agent failed'
        log(`[codex:review:${ID}${suffix(p)}#${attempt}] ${why} — falling back to feature-reviewer`)
        FALLBACKS.push({ stage: `review${suffix(p)}#${attempt}`, reason: why })
        verdict = await claudeReview()
      }
    } else {
      verdict = await claudeReview()
    }
    if (verdict === null) return { ok: false, needsHuman: true, reason: 'reviewer did not complete' }
    log(`[${ID}${suffix(p)}] review ${attempt}/${MAX_REVIEW}: ${verdict.verdict} — ${verdict.summary}`)
    if (verdict.verdict === 'APPROVED') break
    if (verdict.verdict === 'ESCALATE') return { ok: false, needsHuman: true, reason: verdict.summary }
    // NEEDS_WORK → loop back to the implementer (which reads the recorded feedback).
  }

  if (!verdict || verdict.verdict !== 'APPROVED') {
    return { ok: false, needsHuman: true, reason: `still NEEDS_WORK after ${MAX_REVIEW} attempts: ${verdict ? verdict.summary : 'no verdict'}` }
  }

  // Default: fix the reviewer's in-scope advisories BEFORE commit rather than
  // deferring them to a TODO. One polish pass; the implementer re-runs every
  // required check, so a broken advisory-fix cannot land. `defer` advisories are
  // left for the human (surfaced in the run summary), never written to a TODO.
  const autofix = (verdict.advisories || []).filter((a) => a && a.autofix)
  if (autofix.length) {
    phase('Build')
    const polished = await agent(
      `crowi-feature IMPLEMENTER (advisory polish) for task "${ID}"${t}. The reviewer APPROVED the AC ` +
        `but flagged these in-scope improvements — fix them ALL now (this is the default, not optional): ` +
        autofix.map((a, i) => `(${i + 1}) ${a.description}`).join('  ') +
        `. Keep the diff tight, refresh commitPlan, and re-run type-check / test / lint / format — they ` +
        `MUST all stay green. If one of these turns out to be a larger change than a local polish, STOP ` +
        `and set ready=false with the reason (do NOT record it as a TODO); the human decides. Set ` +
        `ready=true once the fixes are in and every required check passes.`,
      { agentType: 'feature-implementer', label: `polish:${ID}${suffix(p)}`, schema: IMPL_RESULT },
    )
    if (polished === null) return { ok: false, needsHuman: true, reason: 'advisory polish pass did not complete' }
    if (!polished.ready) return { ok: false, needsHuman: true, reason: polished.blockedReason || polished.summary || 'advisory polish blocked' }
    log(`[${ID}${suffix(p)}] advisory polish: fixed ${autofix.length} — ${polished.summary}`)
  }

  phase('Commit')
  const last = p === PHASES[PHASES.length - 1]
  const done = await agent(
    `crowi-feature COMMITTER for task "${ID}"${t}. Commit per task.commitPlan: split commits ` +
      `(feat / test / docs(site) / docs(todo) as planned), main-direct, do NOT push. ` +
      (isMulti(p) ? `Mark phase ${p.id} COMMITTED. ` : 'Mark the task COMMITTED. ') +
      (last
        ? 'If the whole task is now COMMITTED with no phases remaining, delete the spec per your instructions. '
        : 'Do NOT delete the spec (more phases remain). ') +
      `If commitPlan and the actual diff disagree and you cannot reconcile them, set committed=false ` +
      `with a reason instead of forcing a commit. Return a structured result.`,
    { agentType: 'feature-committer', label: `commit:${ID}${suffix(p)}`, schema: COMMIT_RESULT },
  )
  if (done === null) return { ok: false, needsHuman: true, reason: 'committer did not complete' }
  if (!done.committed) return { ok: false, needsHuman: done.needsHuman !== false, reason: done.reason || done.summary || 'commit failed' }
  return { ok: true, summary: done.summary, commitShas: done.commitShas || [] }
}

// ---- drive the phases, breaking at the first downstream autoContinue gate ----
const completed = []
for (let i = 0; i < PHASES.length; i++) {
  const p = PHASES[i]
  // The resume/start phase (i === 0) always runs; a later phase that is gated
  // stops the run BEFORE it so a human can review and resume with --phase=<id>.
  if (i > 0 && p.autoContinue === false) {
    return {
      status: 'GATED',
      gatedAt: p.id,
      completed,
      codexFallbacks: FALLBACKS,
      message: `Phase ${p.id} (${p.title}) is gated (autoContinue=false). Resume with: /crowi-feature ${ID} --phase=${p.id}`,
    }
  }
  log(`[${ID}] === phase ${p.id} (${p.title}) ===`)
  const r = await runPhase(p)
  completed.push({ phase: p.id, ...r })
  if (!r.ok) {
    return { status: r.needsHuman ? 'ESCALATE' : 'FAILED', at: p.id, reason: r.reason, completed, codexFallbacks: FALLBACKS }
  }
}
return { status: 'DONE', completed, codexFallbacks: FALLBACKS }
