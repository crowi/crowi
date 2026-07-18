/**
 * A deliberately large flowchart source, used only by
 * render-engine.child-process-isolation.spike.test.ts's gate C tests
 * (§8 C-6/C-7) to make `mermaid.render()` itself take long enough
 * (empirically ~700-900ms in a freshly forked worker, measured while
 * writing this fixture — see the reviewer-fix note below) that a
 * `child.kill('SIGKILL')` sent within single-digit milliseconds of
 * observing the worker's `render-started` IPC message is confidently
 * *during* a real, unfinished `mermaid.render()` call, not before it (the
 * small `flowchart TD\nA-->B` fixture the earlier version of this test
 * used rendered in ~1-2ms, which — combined with an artificial
 * pre-render `setTimeout` the test used to control timing — meant the
 * kill was verified against a delay period, never against an actual
 * in-flight render; see spike-worker.ts's `render-started` message for
 * the other half of this fix).
 *
 * 300 nodes in a chain, plus a back-edge every 5th node (to add layout
 * complexity beyond a trivial straight line) — kept under mermaid's
 * default `maxEdges` security limit (500; 300 chain edges + ~59 back
 * edges = ~359).
 */
function buildLargeFlowchart(nodeCount: number): string {
  const lines = ['flowchart TD'];
  for (let i = 0; i < nodeCount; i++) {
    lines.push(`  N${i}[Node ${i}] --> N${i + 1}[Node ${i + 1}]`);
    if (i > 0 && i % 5 === 0) {
      lines.push(`  N${i}[Node ${i}] --> N${Math.max(0, i - 3)}[Node ${Math.max(0, i - 3)}]`);
    }
  }
  return lines.join('\n');
}

export const LARGE_FLOWCHART_SOURCE = buildLargeFlowchart(300);
