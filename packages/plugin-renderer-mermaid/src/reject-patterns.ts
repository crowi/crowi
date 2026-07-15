/**
 * spec §3 — full-source scan for the two classes of Mermaid input this
 * plugin rejects outright (no allowlist, initial release — spec's
 * "やらないこと"). Runs BEFORE `renderMermaidSvg` is ever called, so a
 * hit never touches a child-process worker slot (spec §6: the cheap
 * checks gate before the expensive resource).
 *
 * Both scans cover the ENTIRE source string, not just the first line —
 * Mermaid's `%%{...}%%` directive preprocessor is a global match (spec
 * §3(a)), and a flowchart vertex shape-data block can appear anywhere
 * in the diagram body (spec §3(b)).
 */

/** §3(a) — `%%{init: ...}%%` (or any `%%{...}%%` directive), anywhere in the source. */
const INIT_DIRECTIVE_RE = /%%\{[\s\S]*?\}%%/;

/** §3(a) — a YAML frontmatter block (`---\n...\n---`) at the very start of the source. */
const FRONTMATTER_RE = /^\s*---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/;

/**
 * §3(b) — shape-data keys Phase 0's no-network gate confirmed cause an
 * outbound-reach attempt mid-render (handoff artifact:
 * `render-engine.no-network.spike.test.ts`'s
 * `CONFIRMED_NETWORK_REACH_PATTERNS`). This is a DATA-only consumption
 * of that handoff — Phase 1 does not re-investigate which constructs
 * reach the network (spec's reuseTargets are explicit about this).
 * Currently one entry: a flowchart vertex shape-data block containing
 * an `img` key (`A@{ img: "..." }`) is classified as mermaid's
 * `imageSquare` shape, whose renderer unconditionally does
 * `new Image(); img.src = node.img; await img.decode();`.
 */
const EXTERNAL_RESOURCE_SHAPE_KEYS = ['img'] as const;

/** Precompiled once (not per scanned block) — one `\bkey\s*:` matcher per entry in `EXTERNAL_RESOURCE_SHAPE_KEYS` above. */
const EXTERNAL_RESOURCE_SHAPE_KEY_PATTERNS: readonly RegExp[] = EXTERNAL_RESOURCE_SHAPE_KEYS.map((key) => new RegExp(`\\b${key}\\s*:`));

/** Any `@{ ... }` shape-data block, scanned for the confirmed key(s) above. */
const SHAPE_DATA_BLOCK_RE = /@\{[^}]*\}/g;

export type RejectReason = 'config_directive' | 'external_resource_reference';

/** Returns the reason the source must be rejected (spec §5 classification A), or `null` if it passes both scans. */
export function detectRejectedSource(source: string): RejectReason | null {
  if (INIT_DIRECTIVE_RE.test(source) || FRONTMATTER_RE.test(source)) return 'config_directive';
  if (containsExternalResourceShapeReference(source)) return 'external_resource_reference';
  return null;
}

function containsExternalResourceShapeReference(source: string): boolean {
  const shapeDataBlocks = source.match(SHAPE_DATA_BLOCK_RE) ?? [];
  return shapeDataBlocks.some((block) => EXTERNAL_RESOURCE_SHAPE_KEY_PATTERNS.some((re) => re.test(block)));
}
