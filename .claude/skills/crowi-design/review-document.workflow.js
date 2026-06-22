export const meta = {
  name: 'crowi-design-review-document',
  description:
    'Phase B of crowi-design: write the final RFC (English) or spec (Japanese) from the approved design brief + locked human decisions, then adversarially review it with 3 independent code-grounded lenses and revise until it passes (bounded). Returns the doc path + verdict + residual open questions. Mirrors the crowi-spec-review lenses for specs and a design-critique panel for RFCs. With reviewOnly=true it skips writing and just reviews an existing doc.',
  phases: [
    { title: 'Write', detail: 'writer turns the brief + decisions into the RFC (opus) or spec (sonnet)' },
    { title: 'Review', detail: '3 parallel adversarial reviewers (opus/high), code-grounded' },
    { title: 'Revise', detail: 'writer fixes blocking issues in place; loop bounded by maxReviewAttempts' },
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
//     reviewOnly?: true, docPath?: '<existing doc>' } // review an existing RFC/spec only
// ----------------------------------------------------------------------------
const SLUG = args.slug
const TITLE = args.title || SLUG
const OUTPUT = args.outputType === 'rfc' ? 'rfc' : 'spec'
const BRIEF = args.briefPath || `.feature-state/design/${SLUG}.brief.md`
const SCOPE = args.scope || 'medium'
const DECISIONS = JSON.stringify(args.decisions || {}, null, 2)
const MAX = args.maxReviewAttempts ?? 2
const REVIEW_ONLY = args.reviewOnly === true
const isRfc = OUTPUT === 'rfc'

const REVIEW = {
  type: 'object',
  required: ['verdict', 'blocking'],
  additionalProperties: true,
  properties: {
    verdict: { type: 'string', enum: ['OK', 'ISSUES'] },
    blocking: {
      type: 'array',
      items: { type: 'string' },
      description: 'concrete, code-grounded blocking issues (each with file:line / section ref). Empty when OK.',
    },
    notes: { type: 'string' },
  },
}
const WRITE_RESULT = {
  type: 'object',
  required: ['docPath'],
  additionalProperties: true,
  properties: {
    docPath: { type: 'string' },
    rfcNumber: { type: 'string' },
    summary: { type: 'string' },
    residualOpenQuestions: { type: 'array', items: { type: 'string' } },
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
          `phasing sanity, clarity for an external contributor, and over-scope (does it re-implement ` +
          `something that already exists? find it with file:line).`,
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

async function runReview(doc, attempt) {
  phase('Review')
  const reviews = (
    await parallel(
      lenses.map((l) => () =>
        agent(
          `crowi-design REVIEWER [${l.key}] of the ${isRfc ? 'RFC' : 'spec'} at ${doc} ` +
            `(the design brief is at ${BRIEF} for context). ${l.task}\n` +
            `Be adversarial and code-grounded: do NOT rubber-stamp, anchor every claim with file:line, ` +
            `read dependency code if needed. Analysis only — do NOT edit the document. Return ` +
            `verdict=ISSUES with a concrete blocking[] list when material problems remain, else ` +
            `verdict=OK with blocking=[].`,
          {
            agentType: 'general-purpose',
            model: 'opus',
            effort: 'high',
            label: `review:${SLUG}:${l.key}#${attempt}`,
            phase: 'Review',
            schema: REVIEW,
          },
        ).then((r) => (r ? { ...r, lens: l.key } : null)),
      ),
    )
  ).filter(Boolean)
  return reviews
}

// ---- review-only path: skip writing, run one adversarial round, report ----
if (REVIEW_ONLY) {
  const doc = args.docPath
  if (!doc) return { status: 'FAILED', reason: 'reviewOnly requires args.docPath', slug: SLUG }
  const reviews = await runReview(doc, 1)
  if (reviews.length === 0) return { status: 'FAILED', reason: 'all reviewers failed', docPath: doc, slug: SLUG }
  const blocking = reviews.flatMap((r) => (r.verdict === 'ISSUES' ? r.blocking : []))
  return {
    status: blocking.length === 0 ? 'OK' : 'ISSUES',
    docPath: doc,
    outputType: OUTPUT,
    blocking,
    reviewSummary: reviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking })),
  }
}

// ---- write -> review -> revise loop ----
phase('Write')
let draft = await agent(
  `crowi-design WRITER for "${TITLE}" (${SLUG}).\n` +
    `Read the approved design brief at ${BRIEF}. Apply the locked human decisions:\n${DECISIONS}\n\n` +
    `${writeInstructions}\n` +
    `Resolve the open questions the human answered; for any still-open question, write it explicitly into ` +
    `the document's open-questions section (do NOT silently drop it). Ground design claims in real code ` +
    `(file:line) where relevant. Return the doc path (+ rfcNumber for an RFC) and any residual open ` +
    `questions.`,
  { agentType: 'general-purpose', model: isRfc ? 'opus' : 'sonnet', label: `write:${SLUG}`, phase: 'Write', schema: WRITE_RESULT },
)
if (draft === null) return { status: 'FAILED', reason: 'writer did not complete', slug: SLUG }
const DOC = draft.docPath

let verdict = null
let lastReviews = []
for (let attempt = 1; attempt <= MAX; attempt++) {
  const reviews = await runReview(DOC, attempt)
  if (reviews.length === 0) return { status: 'FAILED', reason: 'all reviewers failed', docPath: DOC, slug: SLUG }
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
      blocking,
      reviewSummary: reviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking })),
    }
  }
  phase('Revise')
  const revised = await agent(
    `crowi-design WRITER (revision ${attempt}) for the ${isRfc ? 'RFC' : 'spec'} at ${DOC}. The ` +
      `adversarial review found these blocking issues — fix ALL of them in place (edit the document), ` +
      `correcting the design where the reviewers proved it wrong (do NOT just bolt on caveats):\n` +
      `- ${blocking.join('\n- ')}\n` +
      `Keep the document's format / schema intact. Return the (unchanged) doc path and any residual open ` +
      `questions.`,
    { agentType: 'general-purpose', model: isRfc ? 'opus' : 'sonnet', label: `revise:${SLUG}#${attempt}`, phase: 'Revise', schema: WRITE_RESULT },
  )
  if (revised === null) return { status: 'FAILED', reason: 'revision did not complete', docPath: DOC, slug: SLUG }
  if (revised.residualOpenQuestions) draft.residualOpenQuestions = revised.residualOpenQuestions
}

return {
  status: 'DONE',
  docPath: DOC,
  rfcNumber: draft.rfcNumber,
  outputType: OUTPUT,
  verdict,
  residualOpenQuestions: draft.residualOpenQuestions || [],
  reviewSummary: lastReviews.map((r) => ({ lens: r.lens, verdict: r.verdict, blocking: r.blocking })),
}
