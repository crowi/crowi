export const meta = {
  name: 'parallel-feature-train',
  description:
    'Plan queued feature specs, develop the ready ones in parallel worktrees, then merge the green branches into an integration branch ONE AT A TIME with post-merge verification. Specs with open design decisions are gated out of Develop unless force:true. Merge order follows dependency topology, not touch count.',
  phases: [{ title: 'Plan' }, { title: 'Develop' }, { title: 'Integrate' }, { title: 'Simplify' }],
}

// args:
//   specs:       string[]  spec ids under .feature-state/specs/<id>.md (required)
//   mergeTarget: string    branch to build the train on (default: integration branch — never main)
//   repoRoot:    string    absolute path to the main worktree (specs + git live here)
//   force:       boolean   develop specs even if they still have open design decisions (default false)
const specs = args?.specs ?? []
const mergeTarget = args?.mergeTarget ?? 'integration/feature-train'
const repoRoot = args?.repoRoot ?? '/Volumes/working/crowi/crowi'
const force = args?.force ?? false
if (specs.length === 0) {
  log('Pass args:{ specs:["feature-x", ...] }')
  return { error: 'no specs' }
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['id', 'risk', 'scope', 'touches', 'summary'],
  properties: {
    id: { type: 'string' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    scope: { type: 'string', enum: ['small', 'medium', 'large'] },
    touches: { type: 'array', items: { type: 'string' }, description: 'repo-relative files/globs this feature would create or edit' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'other spec ids (in this run) or RFCs this must follow' },
    openDecisions: { type: 'array', items: { type: 'string' }, description: 'design questions still needing a human' },
    summary: { type: 'string' },
  },
}
const BUILD_SCHEMA = {
  type: 'object',
  required: ['id', 'branch', 'green', 'summary'],
  properties: {
    id: { type: 'string' },
    branch: { type: 'string' },
    green: { type: 'boolean', description: 'true only if type-check + lint(0 errors) + tests all passed in-worktree' },
    failures: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
const MERGE_SCHEMA = {
  type: 'object',
  required: ['id', 'merged', 'verified', 'summary'],
  properties: {
    id: { type: 'string' },
    merged: { type: 'boolean' },
    verified: { type: 'boolean', description: 'post-merge type-check + lint + tests on the integration branch' },
    conflicts: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

// --- Phase A: Plan (parallel, read-only) -------------------------------------
phase('Plan')
const plans = (
  await parallel(
    specs.map((id) => () =>
      agent(
        `You are planning, NOT implementing. Read ${repoRoot}/.feature-state/specs/${id}.md in full, then grep/read the ` +
          `codebase under ${repoRoot} to ground the plan. Return: an approach (2-3 sentences), realistic risk + scope, ` +
          `the concrete files this feature would create/edit (drives conflict prediction), any hard dependency on another ` +
          `spec id in this run or an RFC, and any design decision still open for a human. Write no files.`,
        { label: `plan:${id}`, phase: 'Plan', schema: PLAN_SCHEMA, agentType: 'Explore' },
      ),
    ),
  )
).filter(Boolean)

// Merge order = dependency topology (in-run deps only), tie-broken by fewest
// touches. NOT a plain touch-count sort: a feature that builds on another must
// merge after it even if it touches fewer files.
const inRun = new Set(plans.map((p) => p.id))
const depsOf = new Map(plans.map((p) => [p.id, (p.dependsOn || []).filter((d) => inRun.has(d))]))
const byTouches = [...plans].sort((a, b) => (a.touches?.length || 0) - (b.touches?.length || 0))
const ordered = []
const done = new Set()
let progressed = true
while (ordered.length < byTouches.length && progressed) {
  progressed = false
  for (const p of byTouches) {
    if (done.has(p.id)) continue
    if ((depsOf.get(p.id) || []).every((d) => done.has(d))) {
      ordered.push(p)
      done.add(p.id)
      progressed = true
    }
  }
}
for (const p of byTouches) if (!done.has(p.id)) ordered.push(p) // dependency cycle fallback
log(`Merge order (topological): ${ordered.map((p) => p.id).join(' → ')}`)

// Predicted file overlaps — features sharing files must NOT be merged blindly in
// parallel; the serial train resolves the later one against the earlier merge.
const norm = (t) => t.replace(/^\.\//, '').trim()
const overlapFiles = (a, b) => {
  const sb = new Set((b.touches || []).map(norm))
  return [...new Set((a.touches || []).map(norm))].filter((f) => sb.has(f))
}
const conflicts = []
for (let i = 0; i < ordered.length; i++)
  for (let j = i + 1; j < ordered.length; j++) {
    const shared = overlapFiles(ordered[i], ordered[j])
    if (shared.length) conflicts.push({ pair: `${ordered[i].id} → ${ordered[j].id}`, files: shared })
  }
if (conflicts.length) log(`Predicted overlaps: ${conflicts.map((c) => c.pair).join(', ')}`)

// Open-decision gate: don't auto-build specs with unresolved design questions.
const blocked = plans.filter((p) => (p.openDecisions || []).length > 0)
const toBuild = force ? ordered : ordered.filter((p) => !blocked.includes(p))
if (blocked.length) {
  log(`Gated out of Develop (open design decisions — resolve with a human first): ${blocked.map((p) => p.id).join(', ')}`)
}
if (toBuild.length === 0) {
  log('Nothing to build (all specs gated). Returning the plan for human review.')
  return {
    mergeOrder: ordered.map((p) => p.id),
    predictedConflicts: conflicts,
    gated: blocked.map((p) => ({ id: p.id, openDecisions: p.openDecisions, dependsOn: p.dependsOn || [] })),
    plans: plans.map((p) => ({ id: p.id, risk: p.risk, scope: p.scope, summary: p.summary })),
  }
}

// --- Phase B: Develop (parallel, worktree-isolated) --------------------------
phase('Develop')
const built = (
  await parallel(
    toBuild.map((p) => () =>
      agent(
        `Implement the feature spec "${p.id}" (${repoRoot}/.feature-state/specs/${p.id}.md) following its plan. Create ` +
          `branch feature/${p.id} off main. Write the API + web changes. Then VERIFY in this worktree: pnpm type-check, ` +
          `pnpm lint (0 errors), and the relevant package tests (api: pnpm --filter @crowi/api test). Commit on the branch ` +
          `with an English Conventional Commit. Set green=true ONLY if all checks passed.`,
        { label: `build:${p.id}`, phase: 'Develop', isolation: 'worktree', schema: BUILD_SCHEMA },
      ),
    ),
  )
).filter(Boolean)
const green = built.filter((b) => b.green)
const red = built.filter((b) => !b.green)
if (red.length) log(`Failed in-worktree verification, not merging: ${red.map((b) => b.id).join(', ')}`)

// --- Phase C: Integrate train (SERIAL — shared target, one at a time) --------
phase('Integrate')
const orderIndex = new Map(ordered.map((p, i) => [p.id, i]))
const train = green.sort((a, b) => orderIndex.get(a.id) - orderIndex.get(b.id))
const integrated = []
for (const b of train) {
  const r = await agent(
    `On ${repoRoot}, merge branch ${b.branch} into ${mergeTarget} (create ${mergeTarget} off main if absent; do NOT touch ` +
      `main). Resolve only trivial conflicts (lockfile, generated artifacts, additive messages-json); if a conflict needs ` +
      `real judgement, git merge --abort, set merged=false, list the files, stop. After a clean merge: pnpm install if the ` +
      `lockfile changed, then pnpm type-check, pnpm lint, and pnpm --filter @crowi/api test. verified=true only if all pass.`,
    { label: `merge:${b.id}`, phase: 'Integrate', schema: MERGE_SCHEMA },
  )
  if (r) integrated.push(r)
  if (r && r.merged && !r.verified) log(`⚠ ${b.id} merged but post-merge verification FAILED — review before continuing`)
  if (r && !r.merged) log(`⚠ ${b.id} not merged (${(r.conflicts ?? []).join(', ') || 'abort'})`)
}

// --- Phase D: Simplify the cumulative merged diff ----------------------------
phase('Simplify')
const landed = integrated.filter((r) => r.merged && r.verified).map((r) => r.id)
const simplifyReport = landed.length
  ? await agent(
      `On ${repoRoot} branch ${mergeTarget}, review git diff main...${mergeTarget} for reuse / simplification / efficiency / ` +
        `altitude cleanups only (NOT correctness bugs). Apply low-risk fixes in a refactor(merge) commit on ${mergeTarget}; ` +
        `report larger ones in the summary and drop them — there is no backlog to park them in. Return a short summary.`,
      { label: 'simplify:merged', phase: 'Simplify' },
    )
  : 'skipped (nothing landed)'

return {
  mergeTarget,
  mergeOrder: ordered.map((p) => p.id),
  predictedConflicts: conflicts,
  gated: blocked.map((p) => p.id),
  built: built.map((b) => ({ id: b.id, green: b.green, failures: b.failures ?? [] })),
  integrated: integrated.map((r) => ({ id: r.id, merged: r.merged, verified: r.verified })),
  landed,
  simplifyReport,
}
