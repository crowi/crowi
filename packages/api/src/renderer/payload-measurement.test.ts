import { SIDECAR_KEYS } from '@crowi/api-contract';
import type { PluginLogger } from '@crowi/plugin-api';
import { createPipelineEsmDepsLoader, runPipeline } from './pipeline';
import { RendererRegistryImpl } from './registry';
import { sanitizeAst } from './sanitize-ast';
import { serializeMdast } from './serialize';

/**
 * RFC-0023 (parent spec Phase 2 AC) — payload measurement on a
 * representative corpus, recording BOTH directions of the trade:
 *
 *   - stored-AST growth: the sidecar rides alongside the html it
 *     describes (legacy bytes = the same AST with every sidecar
 *     stripped, i.e. the exact pre-RFC-0023 stored shape);
 *   - v1 envelope reduction: the projection drops the `html` value
 *     strings (shiki HTML / base64 data URLs) from the wire.
 *
 * The numbers are printed to the jest output (the recorded artifact);
 * the assertions pin the qualitative shape so a future producer change
 * that silently explodes the stored size or regresses the projection
 * gain fails here.
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();
const runCore = async (body: string) => {
  const reg = new RendererRegistryImpl();
  return runPipeline(body, reg, { mode: 'save', log: silentLogger, actor: { kind: 'system' } }, loadDeps);
};

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Clone with every sidecar key removed — the pre-RFC-0023 stored shape. */
function stripSidecars(value: unknown): unknown {
  const clone = structuredClone(value);
  const stack: unknown[] = [clone];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    const record = node as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object') {
      for (const key of SIDECAR_KEYS) delete data[key];
      if (Object.keys(data).length === 0) delete record.data;
    }
    if (Array.isArray(record.children)) stack.push(record.children);
  }
  return clone;
}

const CODE_FENCE = ['```ts', 'export function greet(name: string): string {', '  return `Hello, ${name}!`;', '}', '```'].join('\n');
const PROSE = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} with a [link](https://example.com/${i}) and some **bold** prose text.`).join('\n\n');

/** A realistic diagram producer output: ~30KB sanitized-SVG base64 inside both the html value and the sidecar. */
function syntheticDiagramNode(): unknown {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">${'<rect width="10" height="10"></rect>'.repeat(700)}</svg>`;
  const base64 = Buffer.from(svg, 'utf8').toString('base64');
  return {
    type: 'html',
    value: `<img class="diagram-embed mermaid-embed" alt="Mermaid diagram" src="data:image/svg+xml;base64,${base64}" width="800" height="600">`,
    data: { crowiDiagram: { kind: 'mermaid', alt: 'Mermaid diagram', image: { mediaType: 'image/svg+xml', base64, width: 800, height: 600 } } },
  };
}

interface Measurement {
  corpus: string;
  legacyBytes: number;
  storedBytes: number;
  storedGrowthPct: number;
  v1Bytes: number;
  v1VsStoredPct: number;
}

function measure(corpus: string, storedAst: unknown): Measurement {
  const storedBytes = bytes(storedAst);
  const legacyBytes = bytes(stripSidecars(storedAst));
  const v1Bytes = bytes(sanitizeAst(storedAst));
  return {
    corpus,
    legacyBytes,
    storedBytes,
    storedGrowthPct: Math.round(((storedBytes - legacyBytes) / legacyBytes) * 1000) / 10,
    v1Bytes,
    v1VsStoredPct: Math.round(((v1Bytes - storedBytes) / storedBytes) * 1000) / 10,
  };
}

describe('RFC-0023 payload measurement (recorded corpus numbers)', () => {
  it('measures stored-AST sidecar growth and v1 envelope reduction across the corpus', async () => {
    const codeHeavy = serializeMdast((await runCore(Array.from({ length: 12 }, () => CODE_FENCE).join('\n\n'))).tree);
    const textHeavy = serializeMdast((await runCore(PROSE)).tree);
    const mixed = serializeMdast((await runCore(`# Mixed\n\n${PROSE.slice(0, 800)}\n\n${CODE_FENCE}\n\n${CODE_FENCE}`)).tree);
    const diagramHeavy = { type: 'root', children: [syntheticDiagramNode(), syntheticDiagramNode(), syntheticDiagramNode()] };

    const results = [measure('code-heavy', codeHeavy), measure('text-heavy', textHeavy), measure('mixed', mixed), measure('diagram-heavy', diagramHeavy)];

    // The recorded artifact — visible in the jest output.
    // eslint-disable-next-line no-console
    console.info(`[RFC-0023 payload measurement]\n${results.map((r) => JSON.stringify(r)).join('\n')}`);

    const byName = new Map(results.map((r) => [r.corpus, r]));

    // Sidecar-carrying corpora grow at rest (the accepted §1 cost)...
    expect(byName.get('code-heavy')!.storedBytes).toBeGreaterThan(byName.get('code-heavy')!.legacyBytes);
    expect(byName.get('diagram-heavy')!.storedBytes).toBeGreaterThan(byName.get('diagram-heavy')!.legacyBytes);
    // ...bounded by the design's "worst ≈ 2x" envelope for diagrams
    // (the sidecar duplicates the base64 the html already embeds).
    expect(byName.get('diagram-heavy')!.storedGrowthPct).toBeLessThanOrEqual(120);
    // Text-heavy pages (no producers) pay nothing.
    expect(byName.get('text-heavy')!.storedGrowthPct).toBe(0);

    // The v1 projection drops the html value strings — declared clients
    // receive LESS than the stored AST wherever producers ran.
    expect(byName.get('code-heavy')!.v1Bytes).toBeLessThan(byName.get('code-heavy')!.storedBytes);
    expect(byName.get('diagram-heavy')!.v1Bytes).toBeLessThan(byName.get('diagram-heavy')!.storedBytes);
  }, 60_000);
});
