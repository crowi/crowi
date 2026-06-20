export const meta = {
  name: 'crowi-feature-pipeline',
  description:
    'Deterministic crowi-feature pipeline. Per phase: plan → implement → (simplify) → review-loop → commit. Multi-phase aware with autoContinue gating. Reuses the feature-{planner,implementer,reviewer,committer} agents via agentType; the control flow (sequencing, NEEDS_WORK retry, phase iteration, gates) is code, so the "narrate the next step then stop" failure mode is structurally impossible.',
  phases: [
    { title: 'Plan', detail: 'feature-planner fills task context + AC + commitPlan (scope-gated)' },
    { title: 'Build', detail: 'feature-implementer: code + tests + crowi-site docs, required checks must pass' },
    { title: 'Review', detail: 'simplify pass + feature-reviewer; loop back to Build on NEEDS_WORK' },
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
//     phases: [{ id, title, autoContinue }]  // from the resume point onward;
//                                            // single-phase => [{ id:'main', ... }]
//   }
// ----------------------------------------------------------------------------
const ID = args.id
const NEEDS_PLANNER = args.needsPlanner !== false
const RUN_SIMPLIFY = args.runSimplify !== false
const MAX_REVIEW = args.maxReviewAttempts ?? 3
const PHASES =
  Array.isArray(args.phases) && args.phases.length ? args.phases : [{ id: 'main', title: ID, autoContinue: true }]

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
    verdict = await agent(
      `crowi-feature REVIEWER for task "${ID}"${t} (attempt ${attempt}/${MAX_REVIEW}). Read ` +
        `.feature-state/tasks/${ID}.json + the uncommitted diff. Verify acceptance criteria` +
        `${isMulti(p) ? ` for ${p.id}` : ''}, api-contract integrity, security, transaction ` +
        `boundaries, and crowi-site docs reflection (when docsTargets is set). Record concrete ` +
        `NEEDS_WORK feedback on the task when not approving. Return your verdict: APPROVED when all AC ` +
        `are met and the quality bar passes; NEEDS_WORK when fixable issues remain; ESCALATE only when ` +
        `a human design decision is genuinely required.`,
      { agentType: 'feature-reviewer', label: `review:${ID}${suffix(p)}#${attempt}`, schema: VERDICT },
    )
    if (verdict === null) return { ok: false, needsHuman: true, reason: 'reviewer did not complete' }
    log(`[${ID}${suffix(p)}] review ${attempt}/${MAX_REVIEW}: ${verdict.verdict} — ${verdict.summary}`)
    if (verdict.verdict === 'APPROVED') break
    if (verdict.verdict === 'ESCALATE') return { ok: false, needsHuman: true, reason: verdict.summary }
    // NEEDS_WORK → loop back to the implementer (which reads the recorded feedback).
  }

  if (!verdict || verdict.verdict !== 'APPROVED') {
    return { ok: false, needsHuman: true, reason: `still NEEDS_WORK after ${MAX_REVIEW} attempts: ${verdict ? verdict.summary : 'no verdict'}` }
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
      message: `Phase ${p.id} (${p.title}) is gated (autoContinue=false). Resume with: /crowi-feature ${ID} --phase=${p.id}`,
    }
  }
  log(`[${ID}] === phase ${p.id} (${p.title}) ===`)
  const r = await runPhase(p)
  completed.push({ phase: p.id, ...r })
  if (!r.ok) {
    return { status: r.needsHuman ? 'ESCALATE' : 'FAILED', at: p.id, reason: r.reason, completed }
  }
}
return { status: 'DONE', completed }
