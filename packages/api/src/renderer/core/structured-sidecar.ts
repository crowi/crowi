import { CrowiDiagramSidecarSchema, CrowiLinkCardSidecarSchema, CrowiPlaceholderSidecarSchema } from '@crowi/api-contract';
import type { StructuredRenderPayload } from '@crowi/plugin-api';
import type { Html } from 'mdast';

/**
 * RFC-0023 (design doc §10) — the ONE mapper every dispatch splice path
 * uses to turn an effective result (`{html, structured?}`) into the
 * `html` mdast node that lands in the persisted AST:
 *
 *   1. `makeCodeBlockDispatch`'s `rewriteChildren`
 *   2. `makeEmbedTagDispatch`'s `rewriteChildren`
 *   3. `redispatchPendingCodeBlocks`' retry splice
 *
 * `structured.node.type` selects the sidecar key; the payload (minus
 * `type`) is validated against the authoritative api-contract sidecar
 * schema BEFORE it is stamped. Validation failure — a third-party
 * plugin's malformed structured output — degrades to a plain `html`
 * node, so broken structured data can never pollute the AST the web
 * reads (the `X-Crowi-Ast-Version: 1` walker re-validates again at
 * response time; this runtime boundary is independently necessary
 * because the walker never sees legacy responses).
 *
 * The `html` string itself is spliced byte-identically to today — the
 * ONLY possible difference is the presence of one `data.<sidecarKey>`.
 */

interface SidecarSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
}

/** For the node types this mapper handles, the sidecar key IS the node type. */
const SIDECAR_SCHEMA_BY_NODE_TYPE: Record<string, SidecarSchema> = {
  crowiDiagram: CrowiDiagramSidecarSchema,
  crowiLinkCard: CrowiLinkCardSidecarSchema,
  crowiPlaceholder: CrowiPlaceholderSidecarSchema,
};

/** An mdast `html` node whose `data` may carry a sidecar. */
export type HtmlWithSidecar = Html & { data?: Record<string, unknown> };

export function buildDispatchHtmlNode(html: string, structured: StructuredRenderPayload | undefined): HtmlWithSidecar {
  const node: HtmlWithSidecar = { type: 'html', value: html };
  if (!structured || typeof structured !== 'object') return node;
  const payloadNode = structured.node;
  if (typeof payloadNode !== 'object' || payloadNode === null) return node;
  const nodeType = (payloadNode as { type?: unknown }).type;
  if (typeof nodeType !== 'string') return node;
  const schema = SIDECAR_SCHEMA_BY_NODE_TYPE[nodeType];
  if (!schema) return node;
  const { type: _type, ...rest } = payloadNode as Record<string, unknown>;
  const parsed = schema.safeParse(rest);
  if (!parsed.success) return node;
  node.data = { [nodeType]: parsed.data };
  return node;
}
