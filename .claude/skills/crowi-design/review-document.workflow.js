export const meta = {
  name: 'crowi-design-review-document',
  description:
    'Phase B of crowi-design: write the final RFC or an implementation-ready spec from the approved design brief + locked human decisions, then adversarially review it with independent code-grounded lenses and revise until it passes (bounded). RFC/spec writing, all codex review lenses, and revision run through .claude/scripts/codex-run.sh and fail open to Claude. Specs are finalized as implementation_ready only after review + deterministic validation pass. With critical=true a Claude red-team lens is added. With reviewOnly=true it skips writing and just reviews an existing doc.',
  phases: [
    { title: 'Write', detail: 'sol writer turns the brief + locked decisions into the RFC or code-grounded spec v2' },
    { title: 'Review', detail: 'parallel adversarial codex lenses (+1 Claude lens when critical), code-grounded' },
    { title: 'Revise', detail: 'writer fixes blocking issues in place (rebutting factually-wrong ones); loop bounded by maxReviewAttempts' },
    { title: 'Finalize', detail: 'approved spec only: deterministic validator green, then mark implementation_ready' },
  ],
}

// ----------------------------------------------------------------------------
// args — the crowi-design SKILL fills these AFTER the human gate:
//   { slug, title,
//     outputType: 'rfc' | 'spec',
//     briefPath: '.feature-state/design/<slug>.brief.md',
//     scope: 'trivial'|'small'|'medium'|'large',   // for the spec case (crowi-feature)
//     decisions: { approach, answers: {...} },      // locked at the gate
//     maxReviewAttempts: 2,
//     critical?: boolean,        // correctness-critical (data loss / auth / race /
//                                // migration / crypto) -> add one Claude lens
//     reviewOnly?: true, docPath?: '<existing doc>' } // review an existing RFC/spec only
// ----------------------------------------------------------------------------
// NOTE: in this runtime the workflow `args` input arrives as a JSON STRING
// (verified by probe: typeof args === 'string'), NOT a parsed object. Reading
// args.* directly yields undefined; a dogfooding run did exactly that and the
// writer wandered and overwrote an unrelated spec. Always go through parseArgs.
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
const SLUG = A.slug
const TITLE = A.title || SLUG
const OUTPUT = A.outputType === 'rfc' ? 'rfc' : 'spec'
const BRIEF = A.briefPath || `.feature-state/design/${SLUG}.brief.md`
const SCOPE = A.scope || 'medium'
const DECISIONS = JSON.stringify(A.decisions || {}, null, 2)
const MAX = A.maxReviewAttempts ?? 2
const REVIEW_ONLY = A.reviewOnly === true
const CRITICAL = A.critical === true
// 縮退した round (codex 判定をほぼ経ていない) を明示的に受け入れる escape hatch。
// 既定 false: 縮退 round は OK/ISSUES ではなく DEGRADED を返す。
const ACCEPT_FALLBACK = A.acceptFallback === true
const isRfc = OUTPUT === 'rfc'
const SPEC_CONTRACT = '.claude/skills/_shared/spec-contract.md'
const SPEC_VALIDATOR = '.claude/skills/_shared/validate-implementation-spec.sh'

// Fail fast BEFORE any agent runs or any file is written. Guards the dogfooding
// failure: string-encoded args -> undefined slug -> the writer overwrote an
// unrelated spec. The write path requires a real slug AND an explicit briefPath.
if (!Number.isInteger(MAX) || MAX < 1) {
  return {
    status: 'FAILED',
    reason: `crowi-design review-document: maxReviewAttempts must be an integer >= 1 (got: ${JSON.stringify(MAX)})`,
  }
} else if (REVIEW_ONLY) {
  if (!A.docPath) return { status: 'FAILED', reason: 'crowi-design review: reviewOnly requires docPath' }
} else if (!SLUG || !A.briefPath) {
  return {
    status: 'FAILED',
    reason: `crowi-design review-document: write path requires slug + briefPath (got: ${JSON.stringify(A)})`,
  }
}

// ----------------------------------------------------------------------------
// codex offload (spec feature-codex-role-split §4): same thin-glue pattern as
// explore-frame.workflow.js (duplicated — workflow scripts cannot import).
// Schemas passed to codex MUST be OpenAI-strict: additionalProperties:false,
// every property in required (optionals as anyOf [T, null]). The strict schema
// doubles as the Claude fallback's StructuredOutput schema.
// ----------------------------------------------------------------------------
const FALLBACKS = []
const REBUTTED = []
// round を跨いで蓄積する (最終 round のものだけ返すと、中間 round が出した
// preexisting / findings が黙って消える)。返却時に dedup 済み。
const PREEXISTING = []
const ALL_FINDINGS = []
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
const RUN_SCOPE = sanitize(SLUG || A.docPath || 'doc')
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

function gluePrompt({ runDir, label, prompt, schema, sandbox, docPathCheck, tier }) {
  return (
    `You are a MECHANICAL RUNNER. Do not analyze the task yourself, do not read the repository, ` +
    `do not improvise.\n` +
    `1) Write these files exactly as given below (Write tool):\n` +
    `   - ${runDir}/prompt.md   <- the content of the PROMPT block (verbatim, without the <<< >>> markers)\n` +
    `   - ${runDir}/schema.json <- the content of the SCHEMA block\n` +
    `2) Run with Bash (set timeout to 600000ms):\n` +
    `   bash .claude/scripts/codex-run.sh --prompt-file ${runDir}/prompt.md --schema-file ${runDir}/schema.json ` +
    `--out ${runDir}/out.json --sandbox ${sandbox} --tier ${tier} --label ${label}\n` +
    `3) Return via structured output, branching ONLY on the script's exit code:\n` +
    `   - exit 0 -> Read ${runDir}/out.json and return {status:"ok", data:<its parsed JSON>}.` +
    (docPathCheck
      ? ` BUT first, when data.wrote is true, verify the document with Bash: \`test -s <data.docPath>\`; ` +
        `if that fails, return {status:"invalid_output", note:"docPath missing/empty: <data.docPath>"} instead.`
      : '') +
    `\n` +
    `   - exit 2, or the Bash call itself errors / times out -> {status:"codex_unavailable", ` +
    `note:<the last line of ${runDir}/out.json.stderr if readable>}\n` +
    `   - exit 3 -> {status:"invalid_output", note:<same>}\n\n` +
    `PROMPT:\n<<<\n${prompt}\n>>>\n` +
    `SCHEMA:\n<<<\n${JSON.stringify(schema)}\n>>>`
  )
}

async function codexStage({ label, phase: ph, prompt, schema, sandbox, docPathCheck, fallback, tier = 'terra' }) {
  const runDir = `.reviews/codex-runs/${RUN_SCOPE}/${sanitize(label)}`
  const glue = await agent(gluePrompt({ runDir, label: sanitize(label), prompt, schema, sandbox, docPathCheck, tier }), {
    model: 'haiku',
    effort: 'low',
    schema: envelope(schema),
    label: `codex:${label}`,
    phase: ph,
  })
  if (glue && glue.status === 'ok' && glue.data) return glue.data
  const why = glue ? `${glue.status}${glue.note ? ` (${glue.note})` : ''}` : 'glue agent failed'
  log(`[codex:${label}] ${why} — falling back to Claude`)
  FALLBACKS.push({ stage: label, reason: why })
  const fb = await fallback()
  // fallback 経由で得た結果に印を付ける — round の縮退判定 (何本の lens が独立した
  // codex 判定を経たか) はこの印を数える。schema 検証は済んでいるので追加してよい。
  return fb && typeof fb === 'object' ? { ...fb, viaFallback: true } : fb
}

const REVIEW = {
  type: 'object',
  required: ['verdict', 'blocking', 'preexisting', 'notes'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['OK', 'ISSUES'] },
    blocking: {
      type: 'array',
      items: { type: 'string' },
      description: 'concrete, code-grounded blocking issues (each with file:line / section ref). Empty when OK.',
    },
    // Pre-existing repository problems the review surfaced but that the doc
    // neither introduced nor worsened. Reported separately so they are not
    // lost, but they never block this doc — they are seeds for other work.
    preexisting: {
      type: 'array',
      items: { type: 'string' },
      description: 'real problems in existing code that predate this design and are not made worse by it. Never blocking here.',
    },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
}
const WRITE_RESULT = {
  type: 'object',
  required: ['wrote', 'docPath', 'rfcNumber', 'summary', 'blockedReason', 'residualOpenQuestions', 'rebutted'],
  additionalProperties: false,
  properties: {
    wrote: {
      type: 'boolean',
      description:
        'true ONLY if you actually wrote the document to the exact target path. false if the brief was missing/empty, or the target path holds an unrelated file (explain in blockedReason). Never write elsewhere.',
    },
    docPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    rfcNumber: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    blockedReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    residualOpenQuestions: { type: 'array', items: { type: 'string' } },
    rebutted: {
      type: 'array',
      items: { type: 'string' },
      description:
        'blocking findings you REFUTED with file:line evidence instead of applying (empty when none). Only for the revision pass.',
    },
  },
}
const FINALIZE_RESULT = {
  type: 'object',
  required: ['ready', 'docPath', 'summary', 'blockedReason'],
  additionalProperties: false,
  properties: {
    ready: { type: 'boolean' },
    docPath: { type: 'string' },
    summary: { type: 'string' },
    blockedReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
}

const writeInstructions = isRfc
  ? `Write an RFC in English to docs/rfcs/00NN-${SLUG}.md. First read the two most recent ` +
    `docs/rfcs/00*.md to match house style (status header, summary, motivation, design, security, ` +
    `alternatives considered, phased plan) and to pick the next free NN. Do NOT commit.`
  : `Write a spec in Japanese to .feature-state/specs/feature-${SLUG}.md. Read ${SPEC_CONTRACT} and ` +
    `follow implementation-ready spec contract v2 EXACTLY. Set frontmatter spec_contract: 2, ` +
    `status: draft, implementation_ready: false, scope: ${SCOPE}, and grounded_at to the current ` +
    `git rev-parse HEAD used for code grounding. After applying the locked decision, RE-OPEN every ` +
    `referenced implementation file and neighboring test/contract code: this is targeted ` +
    `implementation planning, not a prose-only rendering of the brief. Name every changed/new repo-relative ` +
    `path and symbol, exact reuse target, control/data flow, and contracts for public API/types, auth, validation, ` +
    `errors, transaction/concurrency, backward compatibility/migration, and performance/resource limits, ` +
    `stable AC IDs, AC-to-test-file/case/level mappings, and implementation order. Resolve every ` +
    `implementation choice; use an explicit default only when the human left a non-blocking question open. ` +
    `Do not write production function bodies; exact signatures and pseudocode for non-obvious algorithms are ` +
    `allowed. If the work is multi-phase, use the contract's Phase markers so crowi-feature can gate it.`

// Adversarial lenses — different per output type. Specs reuse crowi-spec-review's
// three correctness lenses plus implementation-readiness; RFCs use a
// design-critique panel.
const lenses = isRfc
  ? [
      {
        key: 'approach',
        task:
          `Critique the CHOSEN approach and the alternatives. Are the alternatives sufficient and fairly ` +
          `evaluated? Is the recommended approach actually right given the real codebase constraints ` +
          `(verify them with file:line)? Where is a trade-off understated or a better option missed?`,
      },
      {
        key: 'completeness',
        task:
          `Hunt for what the RFC MISSES: failure modes, security / abuse vectors (remember the web has ` +
          `NO rehype-sanitize), migration / back-compat, multi-instance / concurrency, performance. ` +
          `Make each gap concrete and code-grounded (file:line).`,
      },
      {
        key: 'quality',
        task:
          `Judge OSS-asset quality: internal consistency (no section contradicts another), scope / ` +
          `phasing sanity, clarity for an external contributor, over-scope (does it re-implement ` +
          `something that already exists? find it with file:line), and any brainstorming-context leaks ` +
          `("素案" / "the user" / "with the user" / placeholder "(you)" author) that make it read as a ` +
          `transcript of the design chat rather than a standalone document.`,
      },
    ]
  : [
      {
        key: 'root-cause',
        task:
          `Re-verify the spec's premises and design judgments against real code, skeptically. Judge each ` +
          `key claim 成立 / 過大 / 誤り with file:line. If it diagnoses a bug or behavior, confirm the ` +
          `actual event sequence in the code (and dependency code if needed).`,
      },
      {
        key: 'red-team',
        task:
          `Red-team the planned approach: find paths where it fails to meet the acceptance criteria or ` +
          `leaves a bug / data-loss / inconsistency — multi-instance, concurrency, stale, race, auth ` +
          `boundary, transaction boundary — as concrete event sequences with file:line. State what the ` +
          `spec is missing.`,
      },
      {
        key: 'coverage',
        task:
          `Coverage + architecture: list failure modes / requirements the spec omits (file:line). Is the ` +
          `chosen design right, or is a different architecture materially safer (trade-off with ` +
          `implementation evidence)? Flag over-scope (re-implementing existing code) and wrong ` +
          `scope / priority.`,
      },
      {
        key: 'implementability',
        task:
          `Implementation readiness against ${SPEC_CONTRACT}: verify every implementation-map path and symbol ` +
          `against the real code (new symbols must have an unambiguous neighboring pattern), every change says ` +
          `exactly what to reuse/change without leaving an architectural choice to the implementer, contracts ` +
          `cover API/types, auth, validation, error, transaction/concurrency, backward compatibility/migration, ` +
          `and performance/resource limits or explicit n/a reasons, and every stable AC maps to a ` +
          `concrete test file + case + level. The draft is expected to have status=draft and ` +
          `implementation_ready=false until this review passes; do not flag those two draft markers.`,
      },
    ]

// The extra Claude lens for correctness-critical topics (decision #2:
// critical-only — normally zero Claude lenses, so a codex blind spot is not a
// single point of failure where it matters most). Red-team flavored:
// lenses[1] is completeness (rfc) / red-team (spec).
const claudeCriticalLens = lenses[1]

function lensPrompt(l, doc) {
  return (
    `crowi-design REVIEWER [${l.key}] of the ${isRfc ? 'RFC' : 'spec'} at ${doc} ` +
    `(the design brief is at ${BRIEF} for context). ${l.task}\n` +
    `SCOPE CONTRACT — the human locked these decisions at the design gate; they are settled, not ` +
    `up for re-litigation:\n${DECISIONS}\n` +
    `The document's out-of-scope section ("やらないこと" / non-goals) is part of that contract. Do NOT ` +
    `report the ABSENCE of out-of-scope work as blocking — "this doc does not solve X" is not a finding ` +
    `when X is declared out of scope. What IS blocking: an in-scope change that makes something worse ` +
    `(name the in-scope change and the damage, file:line); an in-scope claim that is factually wrong; ` +
    `an out-of-scope declaration that is self-contradictory (the doc relies on the very thing it excludes).\n` +
    `Pre-existing problems in the repository that this design neither introduced nor worsened go in ` +
    `preexisting[] (still code-grounded, file:line) — they are valuable, but they do not block THIS doc.\n` +
    `Be adversarial and code-grounded: do NOT rubber-stamp, anchor every claim with file:line, ` +
    `read dependency code if needed. Analysis only — do NOT edit the document. Return ` +
    `verdict=ISSUES with a concrete blocking[] list when material problems remain, else ` +
    `verdict=OK with blocking=[].`
  )
}

// ---- structured findings + degraded-round accounting ----------------------
// mustFix: 指摘がこの doc の修正必須になる lens。carryForward: 「何が足りないか」を
// 挙げる系の lens (coverage / completeness) — その指摘は doc を落とすのではなく
// 実装・次の設計へ持ち越す粒度。preexisting は verdict に関係なく全 lens から拾う。
// dedup キーは lens+category+text (同一指摘が複数 round で再出しても 1 件)。
const MUST_FIX_LENSES = new Set(isRfc ? ['approach', 'quality'] : ['root-cause', 'red-team', 'implementability'])
function findingsOf(reviews) {
  const out = []
  const seen = new Set()
  const add = (lens, category, text) => {
    const key = `${lens}\u0000${category}\u0000${text}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ lens, category, text })
  }
  for (const r of reviews) {
    const lens = r.lens || 'unknown'
    // claude-<key> is the same review as <key> run by a different model (see
    // claudeCriticalLens above) — classify it by the underlying lens, not by
    // the claude- prefix, or a lens like claude-completeness (rfc) would be
    // forced mustFix while its codex-run sibling completeness stays carryForward.
    const mustFix = MUST_FIX_LENSES.has(lens.replace(/^claude-/, ''))
    if (r.verdict === 'ISSUES') for (const b of r.blocking || []) add(lens, mustFix ? 'mustFix' : 'carryForward', b)
    for (const pre of r.preexisting || []) add(lens, 'preexisting', pre)
  }
  return out
}
const dedupe = (arr) => [...new Set(arr)]
function collectRound(reviews) {
  for (const f of findingsOf(reviews)) {
    if (!ALL_FINDINGS.some((g) => g.lens === f.lens && g.category === f.category && g.text === f.text)) ALL_FINDINGS.push(f)
  }
  for (const r of reviews) for (const pre of r.preexisting || []) if (!PREEXISTING.includes(pre)) PREEXISTING.push(pre)
}
// round の縮退度 = 独立した codex 判定を経なかった lens の数
// (死んで消えた lens + Claude fallback で走った lens)。fail-open のままだと
// codex が全滅した round でも blocking が空なら OK が返る — 縮退が閾値以上の
// round の verdict は信用せず DEGRADED を返す (ACCEPT_FALLBACK で明示上書き可)。
const DEGRADED_THRESHOLD = CRITICAL ? 3 : 2
function roundStats(reviews, attempt) {
  const planned = lenses.length + (CRITICAL ? 1 : 0)
  const viaFallback = reviews.filter((r) => r.viaFallback === true).length
  const dead = Math.max(0, planned - reviews.length)
  return {
    attempt,
    lensesPlanned: planned,
    lensesReturned: reviews.length,
    viaFallback,
    deadLenses: dead,
    nonIndependent: viaFallback + dead,
  }
}
const isDegradedRound = (stats) => stats.nonIndependent >= DEGRADED_THRESHOLD

async function runReview(doc, attempt) {
  phase('Review')
  // Escalation (crowi-design decision 2026-07-13): reviewers run on the
  // general tier (terra) for early rounds, but the DECISIVE final round
  // (attempt === MAX — the one that flips APPROVED vs NEEDS_WORK) runs on the
  // frontier tier (sol). So a doc that terra keeps bouncing gets one strongest
  // judgment before we give up, without paying sol on every round.
  const reviewTier = attempt === MAX ? 'sol' : 'terra'
  const jobs = lenses.map((l) => () =>
    codexStage({
      label: `review_${l.key}_${attempt}`,
      phase: 'Review',
      sandbox: 'read-only',
      tier: reviewTier,
      schema: REVIEW,
      prompt: lensPrompt(l, doc) + `\nReturn your final answer as JSON matching the output schema.`,
      fallback: () =>
        agent(lensPrompt(l, doc), {
          agentType: 'general-purpose',
          effort: 'high',
          label: `review:${SLUG}:${l.key}#${attempt}`,
          phase: 'Review',
          schema: REVIEW,
        }),
    }).then((r) => (r ? { ...r, lens: l.key } : null)),
  )
  if (CRITICAL) {
    jobs.push(() =>
      agent(lensPrompt({ key: `claude-${claudeCriticalLens.key}`, task: claudeCriticalLens.task }, doc), {
        agentType: 'general-purpose',
        effort: 'high',
        label: `review:${SLUG}:claude-critical#${attempt}`,
        phase: 'Review',
        schema: REVIEW,
      }).then((r) => (r ? { ...r, lens: `claude-${claudeCriticalLens.key}` } : null)),
    )
  }
  return (await parallel(jobs)).filter(Boolean)
}

// ---- review-only path: skip writing, run one adversarial round, report ----
if (REVIEW_ONLY) {
  const doc = A.docPath
  const reviews = await runReview(doc, 1)
  if (reviews.length === 0)
    return { status: 'FAILED', reason: 'all reviewers failed', docPath: doc, slug: SLUG, codexFallbacks: FALLBACKS }
  collectRound(reviews)
  const stats = roundStats(reviews, 1)
  const blocking = reviews.flatMap((r) => (r.verdict === 'ISSUES' ? r.blocking : []))
  const common = {
    docPath: doc,
    outputType: OUTPUT,
    blocking,
    preexisting: dedupe(PREEXISTING),
    findings: ALL_FINDINGS,
    reviewStats: stats,
    reviewSummary: reviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking, preexisting: r.preexisting || [] })),
    codexFallbacks: FALLBACKS,
  }
  // 縮退 round の verdict は信用しない: OK でも ISSUES でも DEGRADED を返し、
  // 呼び出し側 (crowi-spec-review) が「このまま採用するか、codex 復旧後に
  // 再実行するか、acceptFallback: true で明示的に受け入れるか」を決める。
  if (isDegradedRound(stats) && !ACCEPT_FALLBACK) {
    return { status: 'DEGRADED', reason: 'codex_degraded_this_round', ...common }
  }
  return { status: blocking.length === 0 ? 'OK' : 'ISSUES', ...common }
}

// ---- write -> review -> revise loop ----
phase('Write')
const TARGET = isRfc ? `docs/rfcs/00NN-${SLUG}.md (you choose NN = the next free number)` : `.feature-state/specs/feature-${SLUG}.md`
const writerBody =
  `crowi-design WRITER for "${TITLE}" (${SLUG}).\n` +
  `SAFETY: write ONLY to ${TARGET} — never any other file. First confirm the brief exists and is ` +
  `non-empty at ${BRIEF}; if it is missing or empty, do NOT write anything and return wrote=false with a ` +
  `blockedReason. If a file already exists at the target and it describes an UNRELATED feature (not this ` +
  `design), STOP and return wrote=false (conflict) instead of overwriting it.\n` +
  `Those two are the ONLY cases in which you may return wrote=false, and each requires a blockedReason. ` +
  `Writing is otherwise mandatory: an under-specified corner, a decision you cannot settle, or a ` +
  `contradiction you cannot resolve is recorded in residualOpenQuestions — it is never a reason to ` +
  `return without a document. Returning an investigation summary in place of the document is a failure.\n` +
  `The brief is authoritative for MECHANISM (how a thing works, which existing component already does it). ` +
  `The locked decisions are authoritative for JUDGEMENT (which option was chosen, what is out of scope). ` +
  `When the decisions constrain what may not be done, they narrow the brief's mechanism — they do not ` +
  `replace it, and they never license removing something the design is made of. If a decision seems to ` +
  `forbid the feature's own substance, you have misread it: re-read the brief and record the tension in ` +
  `residualOpenQuestions rather than designing the substance away.\n` +
  `Read the approved design brief at ${BRIEF}. Apply the locked human decisions:\n${DECISIONS}\n\n` +
  `${writeInstructions}\n` +
  `AUDIENCE — write the document to stand on its own when read cold from the repo by ` +
  (isRfc ? `an external OSS contributor ` : `the implementer (and crowi-feature) `) +
  `who was NOT in the design conversation; it must NOT read as a transcript of the brainstorming. ` +
  `Forbidden chat-context artifacts: "素案" / "draft proposal" framing; "the user" / "with the user" / ` +
  `"the user's framing" / "we agreed" / "while we're here" referring to the design chat; a placeholder ` +
  `author like "(you)" (use the real author from the brief, or omit the field). Name rejected ` +
  `alternatives by their objective public names (e.g. "a Hugo-style URL fragment"), not "the 素案". ` +
  `(Referring to the END-USER — "ユーザー視点", "the user uploads an image" — is fine; the ban is only on ` +
  `referencing the design conversation.) Every reference must resolve from the repo / other RFCs, never ` +
  `from the chat.\n` +
  `Resolve the open questions the human answered; for any still-open question, write it explicitly into ` +
  `the document's open-questions section (do NOT silently drop it). Ground design claims in real code ` +
  `(file:line) where relevant. Once written, return wrote=true with the doc path (+ rfcNumber for an ` +
  `RFC) and any residual open questions (rebutted=[]).`

// The authoritative RFC/spec is a hardest-tier stage. For specs this is the
// targeted, post-human-gate implementation plan; using a cheaper writer here
// would discard the code-level detail that kickoff relies on.
let draft = await codexStage({
  label: 'write',
  phase: 'Write',
  sandbox: 'workspace-write',
  tier: 'sol',
  schema: WRITE_RESULT,
  docPathCheck: true,
  prompt: writerBody + `\nReturn your final answer as JSON matching the output schema.`,
  fallback: () =>
    agent(writerBody, {
      agentType: 'general-purpose',
      effort: 'high',
      label: `write:${SLUG}`,
      phase: 'Write',
      schema: WRITE_RESULT,
    }),
})
if (draft === null) return { status: 'FAILED', reason: 'writer did not complete', slug: SLUG, codexFallbacks: FALLBACKS }
if (draft.wrote === false)
  return {
    status: 'FAILED',
    reason: draft.blockedReason || 'writer declined to write (missing brief or target conflict)',
    slug: SLUG,
    codexFallbacks: FALLBACKS,
  }
const DOC = draft.docPath
if (!DOC) return { status: 'FAILED', reason: 'writer set wrote=true but returned no docPath', slug: SLUG, codexFallbacks: FALLBACKS }

let verdict = null
let lastReviews = []
for (let attempt = 1; attempt <= MAX; attempt++) {
  const reviews = await runReview(DOC, attempt)
  if (reviews.length === 0)
    return { status: 'FAILED', reason: 'all reviewers failed', docPath: DOC, slug: SLUG, codexFallbacks: FALLBACKS }
  lastReviews = reviews
  collectRound(reviews)
  const stats = roundStats(reviews, attempt)
  // 縮退 round は APPROVED にも NEEDS_WORK にも進めない — この round の verdict
  // 自体が独立した codex 判定をほぼ経ていないため。呼び出し側が codex 復旧後に
  // 再実行するか、acceptFallback: true で明示的に受け入れる。
  if (isDegradedRound(stats) && !ACCEPT_FALLBACK) {
    return {
      status: 'DEGRADED',
      reason: 'codex_degraded_this_round',
      docPath: DOC,
      rfcNumber: draft.rfcNumber,
      outputType: OUTPUT,
      reviewStats: stats,
      findings: ALL_FINDINGS,
      preexisting: dedupe(PREEXISTING),
      reviewSummary: reviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking, preexisting: r.preexisting || [] })),
      codexFallbacks: FALLBACKS,
    }
  }
  const blocking = reviews.flatMap((r) => (r.verdict === 'ISSUES' ? r.blocking : []))
  log(`[${SLUG}] review ${attempt}/${MAX}: ${blocking.length} blocking issue(s) across ${reviews.length} lenses`)
  if (blocking.length === 0) {
    verdict = 'APPROVED'
    break
  }
  if (attempt === MAX) {
    return {
      status: 'NEEDS_WORK',
      docPath: DOC,
      rfcNumber: draft.rfcNumber,
      outputType: OUTPUT,
      residualOpenQuestions: draft.residualOpenQuestions || [],
      rebutted: REBUTTED,
      blocking,
      preexisting: dedupe(PREEXISTING),
      findings: ALL_FINDINGS,
      reviewSummary: reviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking, preexisting: r.preexisting || [] })),
      codexFallbacks: FALLBACKS,
    }
  }
  phase('Revise')
  // Rebuttal rule (independent hardening): a factually-wrong blocking finding
  // must be refuted with file:line evidence and reported in rebutted[], never
  // appeased with bolted-on caveats. Fresh run each time (no codex resume —
  // §15 OQ-4); the doc itself carries the accumulated state.
  const reviseBody =
    `crowi-design WRITER (revision ${attempt}) for the ${isRfc ? 'RFC' : 'spec'} at ${DOC}. The ` +
    `adversarial review found these blocking issues — fix ALL of them in place (edit the document), ` +
    `correcting the design where the reviewers proved it wrong (do NOT just bolt on caveats):\n` +
    `- ${blocking.join('\n- ')}\n` +
    `EXCEPTION — rebuttal: if a blocking finding is itself factually wrong, refute it against real ` +
    `code (file:line), do NOT apply it, and return it in rebutted[] with the evidence. Appeasing a ` +
    `wrong finding by adding caveats to the document is forbidden.\n` +
    `Keep the document's format / schema intact.` +
    (isRfc ? ` ` : ` Keep status: draft and implementation_ready: false; only the finalizer may mark it ready. `) +
    `Return wrote=true, the (unchanged) doc path, any ` +
    `residual open questions, and rebutted[].`
  const revised = await codexStage({
    label: `revise_${attempt}`,
    phase: 'Revise',
    sandbox: 'workspace-write',
    schema: WRITE_RESULT,
    docPathCheck: true,
    prompt: reviseBody + `\nReturn your final answer as JSON matching the output schema.`,
    fallback: () =>
      agent(reviseBody, {
        agentType: 'general-purpose',
        label: `revise:${SLUG}#${attempt}`,
        phase: 'Revise',
        schema: WRITE_RESULT,
      }),
  })
  if (revised === null) return { status: 'FAILED', reason: 'revision did not complete', docPath: DOC, slug: SLUG, codexFallbacks: FALLBACKS }
  if (revised.residualOpenQuestions) draft.residualOpenQuestions = revised.residualOpenQuestions
  if (Array.isArray(revised.rebutted) && revised.rebutted.length) REBUTTED.push(...revised.rebutted)
}

if (verdict !== 'APPROVED') {
  return {
    status: 'FAILED',
    reason: 'crowi-design review-document: review loop ended without an APPROVED verdict',
    docPath: DOC,
    slug: SLUG,
    codexFallbacks: FALLBACKS,
  }
}

if (!isRfc) {
  phase('Finalize')
  const finalize = await agent(
    `You are a MECHANICAL FINALIZER for the approved spec at ${DOC}. Do not redesign or rewrite prose. ` +
      `Change exactly these frontmatter fields: status: draft -> status: approved and ` +
      `implementation_ready: false -> implementation_ready: true. Then run from the repository root: ` +
      `bash "${SPEC_VALIDATOR}" "${DOC}". If it exits 0, return ready=true. If it fails, restore both fields ` +
      `to draft/false and return ready=false with the validator output in blockedReason. Do not edit any ` +
      `other file or field.`,
    {
      model: 'haiku',
      effort: 'low',
      label: `finalize:${SLUG}`,
      phase: 'Finalize',
      schema: FINALIZE_RESULT,
    },
  )
  if (!finalize || !finalize.ready) {
    const reason = finalize?.blockedReason || 'implementation-ready validator did not pass'
    return {
      status: 'NEEDS_WORK',
      docPath: DOC,
      outputType: OUTPUT,
      residualOpenQuestions: draft.residualOpenQuestions || [],
      rebutted: REBUTTED,
      blocking: [reason],
      preexisting: dedupe(PREEXISTING),
      findings: ALL_FINDINGS,
      reviewSummary: lastReviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking, preexisting: r.preexisting || [] })),
      codexFallbacks: FALLBACKS,
    }
  }
}

return {
  status: 'DONE',
  docPath: DOC,
  rfcNumber: draft.rfcNumber,
  outputType: OUTPUT,
  verdict,
  preexisting: dedupe(PREEXISTING),
  findings: ALL_FINDINGS,
  residualOpenQuestions: draft.residualOpenQuestions || [],
  rebutted: REBUTTED,
  reviewSummary: lastReviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking, preexisting: r.preexisting || [] })),
  codexFallbacks: FALLBACKS,
}
