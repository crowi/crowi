export const meta = {
  name: 'crowi-design-explore-frame',
  description:
    'Phase A of crowi-design: research a design topic (codex digest of codebase+prior decisions, read-only, in parallel with an Explore prior-art agent) then synthesize 2-3 design approaches with an RFC-vs-spec recommendation via a codex architect (workspace-write). Writes a full design brief to .feature-state/design/<slug>.brief.md and returns a decision-ready summary for the human gate. Codex stages run through thin haiku glue agents (.claude/scripts/codex-run.sh) and fail open to the original Claude implementations.',
  phases: [
    { title: 'Research', detail: 'codex digest (codebase + prior decisions) ∥ Explore prior-art (sonnet)' },
    { title: 'Frame', detail: 'codex architect: approaches + RFC/spec recommendation + brief; Claude fallback' },
  ],
}

// ----------------------------------------------------------------------------
// args — the crowi-design SKILL fills these:
//   { slug: 'image-display-attributes',   // english kebab slug (file-name safe)
//     topic: '<the design topic, verbatim from the user>',
//     outputHint: 'rfc' | 'spec' | 'auto' } // 'auto' lets the architect recommend
//
// Workflow scripts have no filesystem access, so the AGENTS read/write files
// (.feature-state/design/<slug>.brief.md is written by the architect).
// ----------------------------------------------------------------------------
// NOTE: in this runtime the workflow `args` input arrives as a JSON STRING
// (verified by probe: typeof args === 'string'), NOT a parsed object. Reading
// args.slug directly yields undefined and silently corrupts the run. Always go
// through parseArgs — never read args.* directly.
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
const TOPIC = A.topic
const OUTPUT_HINT = A.outputHint || 'auto'
const BRIEF_PATH = `.feature-state/design/${SLUG}.brief.md`

// Fail fast BEFORE spawning any agent or writing anything: a missing slug/topic
// must never fall through into a path derived from `undefined`.
if (!SLUG || !TOPIC) {
  return { status: 'FAILED', reason: `crowi-design explore-frame: missing required args slug/topic (got: ${JSON.stringify(A)})` }
}

// ----------------------------------------------------------------------------
// codex offload (spec feature-codex-role-split §4): heavy read/analyze stages
// run on `codex exec` through a thin MECHANICAL-RUNNER glue agent (haiku/low,
// near-zero Claude tokens). Any failure fails open to the original Claude
// implementation; every fallback is collected and reported to the caller.
//
// Schemas passed to codex MUST be OpenAI-strict: additionalProperties:false
// and every property listed in required (optional -> type: [..., 'null']).
// The same strict schema doubles as the glue's envelope.data / the Claude
// fallback's StructuredOutput schema.
// ----------------------------------------------------------------------------
const FALLBACKS = []
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
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

function gluePrompt({ runDir, label, prompt, schema, sandbox, writeCheckPath, tier }) {
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
    (writeCheckPath
      ? ` BUT first verify the written document with Bash: \`test -s ${writeCheckPath}\`; if that fails, ` +
        `return {status:"invalid_output", note:"expected document missing/empty: ${writeCheckPath}"} instead.`
      : '') +
    `\n` +
    `   - exit 2, or the Bash call itself errors / times out -> {status:"codex_unavailable", ` +
    `note:<the last line of ${runDir}/out.json.stderr if readable>}\n` +
    `   - exit 3 -> {status:"invalid_output", note:<same>}\n\n` +
    `PROMPT:\n<<<\n${prompt}\n>>>\n` +
    `SCHEMA:\n<<<\n${JSON.stringify(schema)}\n>>>`
  )
}

async function codexStage({ label, phase: ph, prompt, schema, sandbox, writeCheckPath, fallback, tier = 'terra' }) {
  const runDir = `.reviews/codex-runs/${sanitize(SLUG)}/${sanitize(label)}`
  const glue = await agent(gluePrompt({ runDir, label: sanitize(label), prompt, schema, sandbox, writeCheckPath, tier }), {
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

// Decision-ready summary returned to main for the human gate. The full,
// code-grounded detail lives in the brief file (not returned), keeping main
// lean. OpenAI-strict shape (see above) — also used by the Claude fallback.
const FRAME = {
  type: 'object',
  required: ['recommendedOutput', 'outputRationale', 'scope', 'title', 'approaches', 'openQuestions', 'briefPath', 'slug'],
  additionalProperties: false,
  properties: {
    recommendedOutput: { type: 'string', enum: ['rfc', 'spec'] },
    outputRationale: { type: 'string', description: 'one line: why RFC or why spec' },
    scope: {
      type: 'string',
      enum: ['trivial', 'small', 'medium', 'large'],
      description: 'rough implementation scope; used when the output is a spec (feeds crowi-feature)',
    },
    title: { type: 'string', description: 'human-readable design title' },
    approaches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'summary', 'recommended', 'pros', 'cons'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          recommended: { type: 'boolean' },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    openQuestions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'question', 'options', 'recommendation'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
    briefPath: { type: 'string' },
    slug: { type: 'string' },
  },
}
const RESEARCH = {
  type: 'object',
  required: ['codebase', 'prior'],
  additionalProperties: false,
  properties: {
    codebase: { type: 'string', description: 'file:line-anchored markdown digest of the relevant code' },
    prior: { type: 'string', description: 'file:line-anchored markdown digest of prior decisions/docs' },
  },
}

// The two repo-reading digests, previously 2 Explore agents — one codex run.
const codebaseTask =
  `1) codebase — map where this topic would be implemented in the Crowi 2.0 monorepo and what to ` +
  `reuse. Find: the relevant code paths (Hono API handlers, api-contract contracts, web ` +
  `components/hooks, Mongoose models, the remark/mdast renderer pipeline, realtime collab, plugins), ` +
  `reusable utilities and patterns, and the HARD constraints that shape the design (e.g. the web has ` +
  `no rehype-sanitize, the renderer pipeline version, the jwtAuth middleware, sensitive-config ` +
  `encryption, the Mongo->Postgres portability preference). Read CLAUDE.md for conventions.`
const priorTask =
  `2) prior — everything the design must honor or that overlaps with it: docs/rfcs/ (existing RFCs + ` +
  `their decisions and house style), .feature-state/specs/ (in-flight specs), CLAUDE.md, ` +
  `apps/crowi-site/content/docs (user/operator docs). Report related prior decisions, conventions to ` +
  `follow (RFC structure, the crowi-feature spec schema), and any conflicts or overlap. Anchor with ` +
  `file:line / RFC number.`

phase('Research')
const [research, art] = await parallel([
  () =>
    codexStage({
      label: 'research',
      phase: 'Research',
      sandbox: 'read-only',
      tier: 'terra', // codebase/prior-decision digest — general read+summarize
      schema: RESEARCH,
      prompt:
        `crowi-design RESEARCH for the design topic: "${TOPIC}".\n` +
        `You are reading the Crowi 2.0 monorepo (Markdown wiki: Hono API + Next.js web + shared ` +
        `api-contract, pnpm/turborepo). Produce TWO independent digests and return them as JSON ` +
        `{codebase, prior}:\n${codebaseTask}\n${priorTask}\n` +
        `Both digests: concise, file:line-anchored markdown. Locate and ground — do NOT propose a design.`,
      // fallback = the original two Explore agents, verbatim.
      fallback: async () => {
        const [code, prior] = await parallel([
          () =>
            agent(
              `crowi-design RESEARCH (codebase grounding) for the design topic: "${TOPIC}".\n` +
                `Map where this would be implemented in the Crowi 2.0 monorepo and what to reuse. Find: the ` +
                `relevant code paths (Hono API handlers, api-contract contracts, web components/hooks, Mongoose ` +
                `models, the remark/mdast renderer pipeline, realtime collab, plugins), reusable utilities and ` +
                `patterns, and the HARD constraints that shape the design (e.g. the web has no rehype-sanitize, ` +
                `the renderer pipeline version, the jwtAuth middleware, sensitive-config encryption, the ` +
                `Mongo->Postgres portability preference). Read CLAUDE.md for conventions. Anchor every finding ` +
                `with file:line. Return a concise, file:line-anchored markdown digest — locate and ground, do ` +
                `NOT propose a design.`,
              { agentType: 'Explore', model: 'sonnet', label: 'research:codebase', phase: 'Research' },
            ),
          () =>
            agent(
              `crowi-design RESEARCH (prior decisions & docs) for the design topic: "${TOPIC}".\n` +
                `Search for anything the design must honor or that overlaps with it: docs/rfcs/ (existing RFCs + ` +
                `their decisions and house style), .feature-state/specs/ (in-flight specs), CLAUDE.md, ` +
                `apps/crowi-site/content/docs (user/operator docs). Report related prior decisions, conventions ` +
                `to follow (RFC structure, the crowi-feature spec schema), and any conflicts or overlap. Anchor ` +
                `with file:line / RFC number. Return a concise markdown digest — do NOT propose a design.`,
              { agentType: 'Explore', model: 'sonnet', label: 'research:prior', phase: 'Research' },
            ),
        ])
        return { codebase: code || 'n/a', prior: prior || 'n/a' }
      },
    }),
  // prior art needs web search — that stays on the Claude side (decision #1).
  () =>
    agent(
      `crowi-design RESEARCH (prior art) for the design topic: "${TOPIC}".\n` +
        `How do comparable systems, libraries, or specs solve this? Survey the relevant external ` +
        `conventions, notations, libraries, and patterns (use web search/fetch as needed) and extract ` +
        `the trade-offs that matter for Crowi. If the topic is purely internal with no useful external ` +
        `prior art, return exactly "n/a" plus a one-line reason. Return a concise markdown digest — do ` +
        `NOT propose a design.`,
      { agentType: 'Explore', model: 'sonnet', label: 'research:prior-art', phase: 'Research' },
    ),
])
const CODE_DIGEST = (research && research.codebase) || 'n/a'
const PRIOR_DIGEST = (research && research.prior) || 'n/a'

// Architect brief+frame instructions — shared verbatim by the codex run and
// the Claude fallback so a fallback never weakens the contract.
const architectBody =
  `crowi-design ARCHITECT for the design topic: "${TOPIC}".\n\n` +
  `You are given three research digests. Synthesize them into a design frame. Do TWO things:\n\n` +
  `1) WRITE a full design brief (markdown) to ${BRIEF_PATH}. SAFETY: write ONLY to that exact path — ` +
  `   never any other file. This brief is the single source of truth the writer agent will later turn ` +
  `   into the final document, so make it COMPLETE and self-contained: a digest of the grounded ` +
  `   findings (keep the file:line anchors), 2-3 candidate approaches each with how-it-works + ` +
  `   what-to-reuse + trade-offs + risk, the open questions, and — when the output is a spec — ` +
  `   candidate code anchors / likely reuse targets / acceptance-criteria seeds for each viable approach ` +
  `   (do not fully implementation-plan every candidate; the chosen approach is detailed after the human ` +
  `   gate); when an RFC — which existing ` +
  `   RFC(s) to mirror for house style and the security/alternatives angles to cover.\n` +
  `2) RETURN the structured FRAME summary (this is what the human decides on).\n\n` +
  `Recommend RFC vs spec: ` +
  (OUTPUT_HINT === 'auto'
    ? `RFC for a large/cross-cutting design decision worth committing as an OSS asset or that sets ` +
      `precedent; spec for a smaller, directly-implementable task. Set recommendedOutput accordingly. `
    : `the human pre-selected "${OUTPUT_HINT}" — set recommendedOutput="${OUTPUT_HINT}" and tailor the ` +
      `brief to that form. `) +
  `Give 2-3 approaches (mark exactly ONE recommended=true), the open questions that genuinely need a ` +
  `human decision (each with options + your recommendation), a rough scope (for the spec case), a ` +
  `title, briefPath="${BRIEF_PATH}", and slug="${SLUG}". Do NOT write the final RFC/spec yet — only ` +
  `the brief. Ground your reasoning in the digests below.\n\n` +
  `=== CODEBASE ===\n${CODE_DIGEST}\n\n=== PRIOR DECISIONS ===\n${PRIOR_DIGEST}\n\n=== PRIOR ART ===\n${art || 'n/a'}\n`

phase('Frame')
const frame = await codexStage({
  label: 'frame',
  phase: 'Frame',
  sandbox: 'workspace-write',
  tier: 'sol', // design synthesis (approaches + brief) is the hardest stage
  schema: FRAME,
  writeCheckPath: BRIEF_PATH,
  prompt:
    architectBody +
    `\nReturn the FRAME summary as your final answer, as JSON matching the output schema (the brief ` +
    `file must already be written when you answer).`,
  fallback: () =>
    agent(architectBody, {
      agentType: 'general-purpose',
      effort: 'high',
      label: `frame:${SLUG}`,
      phase: 'Frame',
      schema: FRAME,
    }),
})

if (frame === null) {
  return { status: 'FAILED', reason: 'architect did not complete', slug: SLUG, codexFallbacks: FALLBACKS }
}
return { status: 'OK', ...frame, codexFallbacks: FALLBACKS }
