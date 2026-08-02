import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workflowPath = new URL('../review-document.workflow.js', import.meta.url)
const source = (await readFile(workflowPath, 'utf8')).replace('export const meta =', 'const meta =')
const runWorkflow = new Function(
  'args',
  'agent',
  'parallel',
  'phase',
  'log',
  `return (async () => {\n${source}\n})()`,
)

let agentCalls = 0
const result = await runWorkflow(
  JSON.stringify({
    slug: 'invalid-review-count',
    briefPath: '.feature-state/design/invalid-review-count.brief.md',
    outputType: 'spec',
    maxReviewAttempts: 0,
  }),
  async () => {
    agentCalls += 1
    throw new Error('agent must not run for invalid workflow arguments')
  },
  async (jobs) => Promise.all(jobs.map((job) => job())),
  () => {},
  () => {},
)

assert.equal(result.status, 'FAILED')
assert.match(result.reason, /maxReviewAttempts/)
assert.equal(agentCalls, 0)

console.log('PASS: review-document workflow argument validation')
