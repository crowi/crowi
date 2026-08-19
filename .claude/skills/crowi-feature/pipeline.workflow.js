export const meta = {
  name: 'crowi-feature-pipeline',
  description:
    'Deterministic crowi-feature pipeline. Per phase: plan → implement → (simplify) → review-loop → commit. Multi-phase aware with autoContinue gating. Reuses the feature-{planner,implementer,reviewer,committer} agents via agentType; the control flow (sequencing, NEEDS_WORK retry, phase iteration, gates) is code, so the "narrate the next step then stop" failure mode is structurally impossible. With codexReviewer=true the review stage runs objective gates first (fail → NEEDS_WORK without spending any model tokens) and then a codex adversarial review through a thin haiku glue; feature-reviewer remains the fallback.',
  phases: [
    { title: 'Plan', detail: 'legacy spec only: feature-planner discovers task context; ready v2 skips this phase' },
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
//     needsPlanner: boolean,                 // false only for validator-green spec contract v2
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
      return { __parseError: true }
    }
  }
  return {}
}
const A = parseArgs(args)

// ---- structural validation: fail fast BEFORE any agent runs -----------------
// Malformed args must never silently default: a phases array that quietly
// collapses to [{id:'main'}] loses multi-phase gating, and an absent
// autoContinue read as "not false" auto-continues past a gate a human meant
// to hold. Gate-driving booleans are therefore REQUIRED where they gate.
function validateStructural(a) {
  const errors = []
  if (a.__parseError) errors.push('args did not parse as JSON')
  if (typeof a.id !== 'string' || !a.id.trim()) errors.push('id (non-empty string) is required')
  // id is interpolated unquoted into Bash commands run by mechanical agents
  // (the provenance validator call, the metrics --data payload). A space,
  // quote, `;`, or `$(...)` there would break or inject into those commands.
  // The validator's own id format (`^feature-[a-z0-9]+(-[a-z0-9]+)*$`) is
  // narrower than this needs to be for legacy ids, so this only excludes
  // shell metacharacters rather than mirroring it exactly.
  else if (!/^[A-Za-z0-9._-]+$/.test(a.id)) errors.push('id must match [A-Za-z0-9._-]+ (no spaces or shell metacharacters)')
  for (const flag of ['needsPlanner', 'runSimplify', 'codexReviewer', 'resume']) {
    if (a[flag] !== undefined && typeof a[flag] !== 'boolean') errors.push(`${flag} must be a bare boolean when present`)
  }
  if (a.maxReviewAttempts !== undefined && (!Number.isInteger(a.maxReviewAttempts) || a.maxReviewAttempts < 1)) {
    errors.push('maxReviewAttempts must be an integer >= 1 when present')
  }
  if (a.phases !== undefined) {
    if (!Array.isArray(a.phases) || a.phases.length === 0) {
      errors.push('phases must be a non-empty array when present')
    } else {
      a.phases.forEach((p, i) => {
        if (!p || typeof p !== 'object') return errors.push(`phases[${i}] must be an object`)
        if (typeof p.id !== 'string' || !p.id.trim()) errors.push(`phases[${i}].id (non-empty string) is required`)
        if (typeof p.autoContinue !== 'boolean') {
          errors.push(`phases[${i}].autoContinue must be an explicit boolean — absence would silently drop the human gate`)
        }
      })
    }
  }
  return errors
}
const STRUCTURAL_ERRORS = validateStructural(A)
if (STRUCTURAL_ERRORS.length) {
  return {
    status: 'FAILED',
    reason: `crowi-feature pipeline: invalid args — ${STRUCTURAL_ERRORS.join('; ')} (got: ${JSON.stringify(A)})`,
  }
}

const ID = A.id
const NEEDS_PLANNER = A.needsPlanner !== false
const RUN_SIMPLIFY = A.runSimplify !== false
const MAX_REVIEW = A.maxReviewAttempts ?? 3
const CODEX_REVIEWER = A.codexReviewer === true
// resume=true when re-entering at a gated phase (--phase=<id>): provenance
// re-validation then skips only the staleness check, because earlier phases
// have legitimately changed the referenced paths by design.
const RESUME = A.resume === true
const PHASES =
  Array.isArray(A.phases) && A.phases.length ? A.phases : [{ id: 'main', title: ID, autoContinue: true }]

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
  // All task.json writes go through task-state.sh (never Write/Edit — a
  // PreToolUse hook blocks direct writes to .feature-state/tasks/*.json).
  const statusCmd = isMulti(p)
    ? `bash .claude/scripts/task-state.sh task set-phase-status ${ID} ${p.id} <STATUS>`
    : `bash .claude/scripts/task-state.sh task set-status ${ID} <STATUS>`
  const phaseFlag = isMulti(p) ? ` --phase ${p.id}` : ''
  return (
    `You are a MECHANICAL REVIEW RUNNER for crowi-feature task "${ID}"${tag(p)} (attempt ` +
    `${attempt}/${MAX_REVIEW}). Follow the steps EXACTLY in order. Do NOT review or fix any code ` +
    `yourself — your only judgments are pass/fail of commands and copying data.\n\n` +
    `STEP 1 — objective gates. First list the pending work: \`git status --porcelain\` (this ` +
    `includes untracked files — a brand-new file must count). Then run each gate with Bash from ` +
    `the repo root, in order (generous timeouts):\n` +
    `  (a) if any pending file is under packages/api-contract/: pnpm --filter @crowi/api-contract ` +
    `build. Then check OpenAPI freshness WITHOUT calling \`pnpm check:openapi\` directly — that ` +
    `script's freshness signal is \`git status --porcelain\` against git HEAD (its own header ` +
    `comment says it targets pre-push, i.e. AFTER this feature's contract diff is already ` +
    `committed). Review always runs BEFORE the commit phase, so a correct-but-uncommitted contract ` +
    `diff would always be misreported as "stale" by that check — a structural false positive, not a ` +
    `defect in the task. Verify freshness instead by diffing a regen against a pre-regen snapshot of ` +
    `the SAME working tree (git-HEAD-independent):\n` +
    `    d=$(mktemp -d)\n` +
    `    cp packages/api-contract/openapi.json packages/api-contract/openapi.yaml packages/api-contract/src/generated/openapi.ts "$d/"\n` +
    `    pnpm --filter @crowi/api-contract generate\n` +
    `    diff -q packages/api-contract/openapi.json "$d/openapi.json" && diff -q packages/api-contract/openapi.yaml "$d/openapi.yaml" && diff -q packages/api-contract/src/generated/openapi.ts "$d/openapi.ts"; FRESH=$?; rm -rf "$d"\n` +
    `  \`generate\` failing (a build/type error) is itself a gate failure. Otherwise FRESH=0 means ` +
    `the artifacts are fresh (gate passes); FRESH!=0 means stale (gate fails — the diffed lines are ` +
    `the blocking detail).\n` +
    `  (b) pnpm --filter @crowi/api type-check\n` +
    `  (c) if any pending file is under packages/web/: pnpm --filter @crowi/web type-check\n` +
    `  (d) pnpm --filter @crowi/api test\n` +
    `  (e) pnpm lint   (errors must be 0; warnings tolerated)\n` +
    `  (f) if any pending file is under packages/e2e/: pnpm --filter @crowi/e2e type-check, then ` +
    `run the affected specs — changed tests/*.spec.ts files only when specs changed, the FULL ` +
    `suite (pnpm --filter @crowi/e2e e2e) when only shared support files (src/, runner/, ` +
    `playwright.config.ts) changed. The setup project runs automatically. If the run cannot ` +
    `start because the docker infra (mongo/redis) is down, that gate fails with message ` +
    `"blocked: e2e infra down".\n` +
    `If ANY gate fails: do NOT run codex. Your verdict is ` +
    `{verdict:"NEEDS_WORK", summary:"objective gates failed", blocking:[one entry per failed gate: ` +
    `the command + the key error lines], advisories:[]} — go directly to STEP 4.\n\n` +
    `STEP 2 — build the review prompt (only when every gate passed):\n` +
    `  Read .feature-state/tasks/${ID}.json and extract: the acceptance criteria` +
    `${isMulti(p) ? ` for phase ${p.id}` : ''} and the most recent reviewFeedback if present. Also read the ` +
    `entire .feature-state/specs/${ID}.md when it exists. For contract v2, derive docs and e2e obligations from the spec itself ` +
    `(implementation map, test plan, and implementation order), even when task.context has no docsTargets or ` +
    `e2eTargets; embed those exact obligations together with the implementation map, contracts/invariants, ` +
    `AC-to-test mapping, and implementation order. For legacy specs, extract optional context.docsTargets and ` +
    `context.e2eTargets from the task and embed at least "## 設計の主な判断".\n` +
    `  Write ${runDir}/prompt.md: instructions for an adversarial review of the UNCOMMITTED work — ` +
    `tell the reviewer to gather it itself with \`git status --porcelain\` + \`git diff HEAD\` and ` +
    `to read untracked files directly. It must verify every acceptance criterion (embed the AC ` +
    `list verbatim), api-contract integrity, security, transaction boundaries, and exact conformance ` +
    `to the v2 spec. Missing any docs or e2e work explicitly required by a contract v2 spec is blocking ` +
    `and must produce NEEDS_WORK, regardless of whether task.context repeats the requirement. For a legacy ` +
    `spec only, check crowi-site docs when docsTargets is set (embed docsTargets + the design judgments ` +
    `verbatim), and when e2eTargets.assessment is "critical-flow", check the listed flows; absent legacy e2e ` +
    `coverage remains an advisory with autofix=true rather than blocking. Ask ` +
    `for verdict APPROVED (all AC met, quality bar passes) / NEEDS_WORK (fixable issues; list them ` +
    `in blocking[], each with file:line) / ESCALATE (only when a human design decision is genuinely ` +
    `required), plus advisories[] — non-blocking improvements each tagged autofix true ` +
    `(in-scope/mechanical, the default) or false (genuinely out-of-scope). Lean autofix.\n` +
    `  Write ${runDir}/schema.json with the SCHEMA block below.\n\n` +
    `STEP 3 — run codex with Bash (set timeout to 600000ms). Use exec mode — codex's review ` +
    `subcommand ignores custom prompts/schemas:\n` +
    `  bash .claude/scripts/codex-run.sh --sandbox read-only ` +
    `--prompt-file ${runDir}/prompt.md --schema-file ${runDir}/schema.json ` +
    `--out ${runDir}/out.json --label review-${sanitize(ID)}\n` +
    `  - exit 0 -> your verdict is the JSON in ${runDir}/out.json\n` +
    `  - exit 2, or the Bash call errors / times out -> return {status:"codex_unavailable", ` +
    `note:<last line of ${runDir}/out.json.stderr>} and STOP (skip STEP 4)\n` +
    `  - exit 3 -> return {status:"invalid_output", note:<same>} and STOP (skip STEP 4)\n\n` +
    `STEP 4 — record + return (only when you hold a verdict from STEP 1 or STEP 3). Update ` +
    `.feature-state/tasks/${ID}.json ONLY via .claude/scripts/task-state.sh — do NOT Write/Edit the ` +
    `file directly (a PreToolUse hook blocks that; task-state.sh is the only allowed write path and ` +
    `exists specifically to stop that failure mode)${isMulti(p) ? `. Every command below targets ` +
    `the phases[] entry with id "${p.id}"` : ''}:\n` +
    `  1) status — \`${statusCmd}\` where <STATUS> is APPROVED when verdict=APPROVED, NEEDS_WORK ` +
    `when verdict=NEEDS_WORK. Skip this command entirely for ESCALATE (leave the current status ` +
    `as-is).\n` +
    `  2) reviewAttempts — \`bash .claude/scripts/task-state.sh task set-field ${ID} reviewAttempts ` +
    `${attempt}${phaseFlag}\`\n` +
    `  3) reviewFeedback — write {decision: <verdict>, by: "gates"|"codex", reviewedAt: <UTC time ` +
    `from \`date -u +%FT%TZ\`>, summary: <summary>, issues: [one {severity:"high", file:<file:line ` +
    `if present in the blocking entry, else "">, message:<the blocking entry>, suggestion:""} per ` +
    `blocking entry], advisories: <advisories>} to ${runDir}/review-feedback.json (a scratch path, ` +
    `NOT under .feature-state/tasks/ — the hook blocks Write there too), then run ` +
    `\`bash .claude/scripts/task-state.sh task set-field ${ID} reviewFeedback ` +
    `--value-file ${runDir}/review-feedback.json${phaseFlag}\`\n` +
    `  4) history — \`bash .claude/scripts/task-state.sh task append-history ${ID} ` +
    `'{"phase":"reviewer","at":"<UTC time from date -u +%FT%TZ>","summary":"<verdict + 1 line>"}'\`\n` +
    `  Return {status:"ok", data:<the verdict JSON — verdict/summary/blocking/advisories>}.\n\n` +
    `SCHEMA:\n<<<\n${JSON.stringify(VERDICT_STRICT)}\n>>>`
  )
}

// One full phase cycle: plan? → (implement → simplify? → review)* → commit.
async function runPhase(p) {
  const t = tag(p)

  if (NEEDS_PLANNER) {
    phase('Plan')
    const planned = await agent(
      `crowi-feature LEGACY PLANNER for task "${ID}"${t}. This phase runs only because the spec is not ` +
        `implementation-ready contract v2. Read .feature-state/specs/${ID}.md and ` +
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
      `crowi-feature IMPLEMENTER for task "${ID}"${t} (attempt ${attempt}/${MAX_REVIEW}). Read the entire ` +
        `.feature-state/specs/${ID}.md and .feature-state/tasks/${ID}.json when present. For contract v2, ` +
        `the spec's path/symbol implementation map is authoritative: if task state is missing, seed only ` +
        `minimal runtime state from the spec without broad grep or architectural replanning. Read the referenced ` +
        `files, then implement the code + tests + crowi-site docs/e2e named by the spec. If a referenced symbol or ` +
        `grounded assumption no longer matches, set ready=false and escalate instead of redesigning silently. ` +
        `For legacy specs, use the planner-created task context. Run type-check / test / lint / format — they MUST ` +
        `all pass. Fill/refresh ` +
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
          `.feature-state/tasks/${ID}.json + the full spec + the uncommitted diff. Verify acceptance criteria` +
          `${isMulti(p) ? ` for ${p.id}` : ''}, api-contract integrity, security, transaction ` +
          `boundaries, and crowi-site docs reflection. For contract v2, independently derive docs/e2e obligations from the spec itself ` +
          `(implementation map, test plan, and implementation order), not only task.context, and verify exact conformance to every ` +
          `implementation-map path/symbol and AC-to-test mapping. Missing explicitly required v2 docs/e2e work or any other ` +
          `unexplained deviation from the approved v2 plan is NEEDS_WORK. Record concrete ` +
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

// ---- v2 provenance gate: the pipeline verifies the caller's claim itself ----
// needsPlanner=false means "this spec passed validate-implementation-spec.sh".
// That used to be the caller's self-report; a caller could skip planning
// without the spec ever being machine-validated. The pipeline now runs the
// validator itself (via a mechanical agent — workflow scripts have no
// filesystem access) and refuses to proceed on a claim it cannot verify.
// The same agent reads frontmatter `kind`: an umbrella spec must not enter
// the v2 fast path, because nothing on this path derives its sub-spec phases —
// the default [{id:'main'}] would silently run an umbrella as a single phase.
const PROVENANCE = {
  type: 'object',
  required: ['ready', 'kind', 'detail'],
  additionalProperties: false,
  properties: {
    ready: { type: 'boolean' },
    kind: { type: 'string', enum: ['leaf', 'umbrella', 'unknown'] },
    detail: { type: 'string' },
  },
}
async function verifyProvenance() {
  const flag = RESUME ? '--structure-only ' : ''
  return await agent(
    `You are a MECHANICAL RUNNER. Do not analyze the spec yourself.\n` +
      `1) Run with Bash: bash .claude/skills/_shared/validate-implementation-spec.sh ${flag}.feature-state/specs/${ID}.md\n` +
      `2) Read the frontmatter of .feature-state/specs/${ID}.md (the first --- block) and note the value of its "kind:" line, if any.\n` +
      `3) Return {ready: <true iff step 1 exited 0>, kind: <this is about the frontmatter "kind:" line alone, ` +
      `independent of step 1's exit code — "umbrella" if that line's value is exactly umbrella; "leaf" if there ` +
      `is no "kind:" line in the frontmatter at all; "unknown" for any other kind: value>, ` +
      `detail: <the last 3 lines of step 1 output>}.`,
    { model: 'haiku', effort: 'low', label: `validate-spec:${ID}`, schema: PROVENANCE },
  )
}

// ---- drive the phases, breaking at the first downstream autoContinue gate ----
async function drivePhases() {
  if (!NEEDS_PLANNER) {
    const prov = await verifyProvenance()
    if (!prov || !prov.ready) {
      return {
        status: 'FAILED',
        reason:
          `crowi-feature pipeline: needsPlanner=false claims a validator-green contract v2 spec, but ` +
          `validate-implementation-spec.sh did not pass${RESUME ? ' (structure-only)' : ''}: ` +
          (prov ? prov.detail : 'validation agent did not complete'),
        codexFallbacks: FALLBACKS,
      }
    }
    if (prov.kind === 'umbrella') {
      // Last-resort backstop: crowi-feature/SKILL.md 2.2 is supposed to route
      // any `kind: umbrella` spec to needsPlanner=true BEFORE this workflow
      // ever runs, precisely because nothing on the v2 fast path derives an
      // umbrella's sub-spec phases (the default [{id:'main'}] would silently
      // run it as one phase). Reaching this branch means that routing did
      // not happen — treat it as a caller bug, not a normal outcome.
      return {
        status: 'FAILED',
        reason:
          `crowi-feature pipeline: ${ID} is an umbrella spec but was routed onto the v2 fast path ` +
          `(needsPlanner=false). This should not happen — crowi-feature/SKILL.md 2.2 must route ` +
          `umbrella specs to needsPlanner=true before invoking this workflow. Re-run crowi-feature ` +
          `for ${ID} so it detects kind: umbrella and takes the planner path.`,
        codexFallbacks: FALLBACKS,
      }
    }
    if (prov.kind === 'unknown') {
      // A kind: value that is neither absent nor "umbrella" cannot be told apart
      // from a mistyped "umbrella" (e.g. a stray capital or typo) — refuse rather
      // than silently treating it as a leaf spec, which is what would let a
      // genuine umbrella slip onto the fast path undetected.
      return {
        status: 'FAILED',
        reason:
          `crowi-feature pipeline: ${ID}'s frontmatter has a "kind:" value that is neither absent nor ` +
          `"umbrella" (validator agent reported kind=unknown). Fix the frontmatter — omit kind: for a ` +
          `leaf spec, or set kind: umbrella — then retry.`,
        codexFallbacks: FALLBACKS,
      }
    }
  }

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
}

const finalResult = await drivePhases()

// ---- run metrics (best-effort; must never change the run result) -----------
// One JSON line per run in .reviews/codex-runs/<id>/metrics.jsonl, so pipeline
// tuning (review attempts, codex fallback rate, gate placement) is judged from
// measurements instead of feel. Values are enums / numbers / kebab ids only —
// the payload rides a Bash --data argument, so it must not contain a single
// quote. The child process stamps the timestamp (this runtime blocks Date).
try {
  const m = {
    workflow: 'crowi-feature-pipeline',
    id: ID,
    status: finalResult.status,
    phasesPlanned: PHASES.length,
    phasesCompleted: (finalResult.completed || []).length,
    codexFallbacks: FALLBACKS.length,
    needsPlanner: NEEDS_PLANNER,
    codexReviewer: CODEX_REVIEWER,
    resume: RESUME,
  }
  await agent(
    `You are a MECHANICAL RUNNER. Run exactly this with Bash and return {recorded: <true iff exit 0>}:\n` +
      `node .claude/scripts/record-run-metrics.mjs --dir .reviews/codex-runs/${ID} --data '${JSON.stringify(m)}'`,
    {
      model: 'haiku',
      effort: 'low',
      label: `metrics:${ID}`,
      schema: { type: 'object', required: ['recorded'], additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
    },
  )
} catch {
  // best-effort by contract
}

return finalResult
