export const meta = {
  name: 'crowi-design-explore-frame',
  description:
    'Phase A of crowi-design: research a design topic in parallel (codebase grounding / prior decisions / prior art) then synthesize 2-3 design approaches with an RFC-vs-spec recommendation. Writes a full design brief to .feature-state/design/<slug>.brief.md and returns a decision-ready summary for the human gate. Heavy reading stays in subagents so the main agent only holds the summary.',
  phases: [
    { title: 'Research', detail: '3 Explore agents (sonnet, parallel): codebase / prior decisions / prior art' },
    { title: 'Frame', detail: 'architect (opus/high): approaches + RFC/spec recommendation + open questions; writes the brief' },
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
const SLUG = args.slug
const TOPIC = args.topic
const OUTPUT_HINT = args.outputHint || 'auto'
const BRIEF_PATH = `.feature-state/design/${SLUG}.brief.md`

// Decision-ready summary returned to main for the human gate. The full,
// code-grounded detail lives in the brief file (not returned), keeping main lean.
const FRAME = {
  type: 'object',
  required: ['recommendedOutput', 'title', 'approaches', 'briefPath', 'slug'],
  additionalProperties: true,
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
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'summary', 'recommended'],
        additionalProperties: true,
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
        required: ['id', 'question'],
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
        },
      },
    },
    briefPath: { type: 'string' },
    slug: { type: 'string' },
  },
}

phase('Research')
const [code, prior, art] = await parallel([
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
        `their decisions and house style), .feature-state/specs/ (in-flight specs), TODO.md, CLAUDE.md, ` +
        `apps/crowi-site/content/docs (user/operator docs). Report related prior decisions, conventions ` +
        `to follow (RFC structure, the crowi-feature spec schema), and any conflicts or overlap. Anchor ` +
        `with file:line / RFC number. Return a concise markdown digest — do NOT propose a design.`,
      { agentType: 'Explore', model: 'sonnet', label: 'research:prior', phase: 'Research' },
    ),
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

phase('Frame')
const frame = await agent(
  `crowi-design ARCHITECT for the design topic: "${TOPIC}".\n\n` +
    `You are given three research digests. Synthesize them into a design frame. Do TWO things:\n\n` +
    `1) WRITE a full design brief (markdown) to ${BRIEF_PATH}. This brief is the single source of truth ` +
    `   the writer agent will later turn into the final document, so make it COMPLETE and self-contained: ` +
    `   a digest of the grounded findings (keep the file:line anchors), 2-3 candidate approaches each ` +
    `   with how-it-works + what-to-reuse + trade-offs + risk, the open questions, and — when the output ` +
    `   is a spec — concrete reuse targets / new files / acceptance-criteria seeds; when an RFC — which ` +
    `   existing RFC(s) to mirror for house style and the security/alternatives angles to cover.\n` +
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
    `=== CODEBASE ===\n${code || 'n/a'}\n\n=== PRIOR DECISIONS ===\n${prior || 'n/a'}\n\n=== PRIOR ART ===\n${art || 'n/a'}\n`,
  { agentType: 'general-purpose', model: 'opus', effort: 'high', label: `frame:${SLUG}`, phase: 'Frame', schema: FRAME },
)

if (frame === null) {
  return { status: 'FAILED', reason: 'architect did not complete', slug: SLUG }
}
return { status: 'OK', ...frame }
