export const meta = {
  name: 'crowi-design-review-document',
  description:
    'Phase B of crowi-design: write the final RFC (English) or spec (Japanese) from the approved design brief + locked human decisions, then adversarially review it with 3 independent code-grounded lenses and revise until it passes (bounded). RFC writing, all review lenses, and RFC revision run on codex (through thin haiku glue + .claude/scripts/codex-run.sh) and fail open to the original Claude implementations; the spec writer stays on Claude sonnet. With critical=true a Claude red-team lens is added on top of the codex lenses. Returns the doc path + verdict + residual open questions + rebutted findings. With reviewOnly=true it skips writing and just reviews an existing doc.',
  phases: [
    { title: 'Write', detail: 'writer turns the brief + decisions into the RFC (codex) or spec (sonnet)' },
    { title: 'Review', detail: '3 parallel adversarial codex lenses (+1 Claude lens when critical), code-grounded' },
    { title: 'Revise', detail: 'writer fixes blocking issues in place (rebutting factually-wrong ones); loop bounded by maxReviewAttempts' },
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
const isRfc = OUTPUT === 'rfc'

// Fail fast BEFORE any agent runs or any file is written. Guards the dogfooding
// failure: string-encoded args -> undefined slug -> the writer overwrote an
// unrelated spec. The write path requires a real slug AND an explicit briefPath.
if (REVIEW_ONLY) {
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

function gluePrompt({ runDir, label, prompt, schema, sandbox, docPathCheck }) {
  return (
    `You are a MECHANICAL RUNNER. Do not analyze the task yourself, do not read the repository, ` +
    `do not improvise.\n` +
    `1) Write these files exactly as given below (Write tool):\n` +
    `   - ${runDir}/prompt.md   <- the content of the PROMPT block (verbatim, without the <<< >>> markers)\n` +
    `   - ${runDir}/schema.json <- the content of the SCHEMA block\n` +
    `2) Run with Bash (set timeout to 600000ms):\n` +
    `   bash .claude/scripts/codex-run.sh --prompt-file ${runDir}/prompt.md --schema-file ${runDir}/schema.json ` +
    `--out ${runDir}/out.json --sandbox ${sandbox} --label ${label}\n` +
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

async function codexStage({ label, phase: ph, prompt, schema, sandbox, docPathCheck, fallback }) {
  const runDir = `.reviews/codex-runs/${RUN_SCOPE}/${sanitize(label)}`
  const glue = await agent(gluePrompt({ runDir, label: sanitize(label), prompt, schema, sandbox, docPathCheck }), {
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
  return await fallback()
}

const REVIEW = {
  type: 'object',
  required: ['verdict', 'blocking', 'notes'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['OK', 'ISSUES'] },
    blocking: {
      type: 'array',
      items: { type: 'string' },
      description: 'concrete, code-grounded blocking issues (each with file:line / section ref). Empty when OK.',
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

const writeInstructions = isRfc
  ? `Write an RFC in English to docs/rfcs/00NN-${SLUG}.md. First read the two most recent ` +
    `docs/rfcs/00*.md to match house style (status header, summary, motivation, design, security, ` +
    `alternatives considered, phased plan) and to pick the next free NN. Do NOT commit.`
  : `Write a spec in Japanese to .feature-state/specs/feature-${SLUG}.md following the crowi-feature spec ` +
    `schema EXACTLY: frontmatter (id: feature-${SLUG}, name, scope: ${SCOPE}), then the sections ` +
    `"## 背景 / why", "## やること (ユーザー視点)", "## やらないこと (out of scope)", ` +
    `"## 設計の主な判断", "## 受け入れ基準 (acceptance criteria)" (as a checklist), ` +
    `"## 未確定事項 (open questions)". If the work is multi-phase, use ` +
    `"### Phase N: <title> (即時 / 非衝突)" or "(要調整)" headers so crowi-feature can gate them. ` +
    `The spec must be directly consumable by /crowi-feature.`

// Adversarial lenses — different per output type. Specs reuse crowi-spec-review's
// three lenses; RFCs use a design-critique panel.
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
    `Be adversarial and code-grounded: do NOT rubber-stamp, anchor every claim with file:line, ` +
    `read dependency code if needed. Analysis only — do NOT edit the document. Return ` +
    `verdict=ISSUES with a concrete blocking[] list when material problems remain, else ` +
    `verdict=OK with blocking=[].`
  )
}

async function runReview(doc, attempt) {
  phase('Review')
  const jobs = lenses.map((l) => () =>
    codexStage({
      label: `review_${l.key}_${attempt}`,
      phase: 'Review',
      sandbox: 'read-only',
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
  const blocking = reviews.flatMap((r) => (r.verdict === 'ISSUES' ? r.blocking : []))
  return {
    status: blocking.length === 0 ? 'OK' : 'ISSUES',
    docPath: doc,
    outputType: OUTPUT,
    blocking,
    reviewSummary: reviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking })),
    codexFallbacks: FALLBACKS,
  }
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

// RFC writer runs on codex (decision #1); the spec writer stays on Claude
// sonnet (Japanese + strict schema — revisit after Phase 1 bedding-in).
let draft = isRfc
  ? await codexStage({
      label: 'write',
      phase: 'Write',
      sandbox: 'workspace-write',
      schema: WRITE_RESULT,
      docPathCheck: true,
      prompt: writerBody + `\nReturn your final answer as JSON matching the output schema.`,
      fallback: () =>
        agent(writerBody, {
          agentType: 'general-purpose',
          label: `write:${SLUG}`,
          phase: 'Write',
          schema: WRITE_RESULT,
        }),
    })
  : await agent(writerBody, {
      agentType: 'general-purpose',
      model: 'sonnet',
      label: `write:${SLUG}`,
      phase: 'Write',
      schema: WRITE_RESULT,
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
      reviewSummary: reviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking })),
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
    `Keep the document's format / schema intact. Return wrote=true, the (unchanged) doc path, any ` +
    `residual open questions, and rebutted[].`
  const revised = isRfc
    ? await codexStage({
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
    : await agent(reviseBody, {
        agentType: 'general-purpose',
        model: 'sonnet',
        label: `revise:${SLUG}#${attempt}`,
        phase: 'Revise',
        schema: WRITE_RESULT,
      })
  if (revised === null) return { status: 'FAILED', reason: 'revision did not complete', docPath: DOC, slug: SLUG, codexFallbacks: FALLBACKS }
  if (revised.residualOpenQuestions) draft.residualOpenQuestions = revised.residualOpenQuestions
  if (Array.isArray(revised.rebutted) && revised.rebutted.length) REBUTTED.push(...revised.rebutted)
}

return {
  status: 'DONE',
  docPath: DOC,
  rfcNumber: draft.rfcNumber,
  outputType: OUTPUT,
  verdict,
  residualOpenQuestions: draft.residualOpenQuestions || [],
  rebutted: REBUTTED,
  reviewSummary: lastReviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking })),
  codexFallbacks: FALLBACKS,
}
