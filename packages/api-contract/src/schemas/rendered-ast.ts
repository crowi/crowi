import { z } from '@hono/zod-openapi';

/**
 * RFC-0023 / feature-rendered-ast-wire-contract — the `renderedAst`
 * wire contract.
 *
 * Two independent layers live in this file:
 *
 * 1. **The OpenAPI-facing wire union** (`RenderedAstValueSchema`):
 *    `RenderedAstEnvelopeOpenApiSchema | LooseRenderedAstRootSchema`.
 *    The envelope member keeps `root` as `z.unknown()` at the OpenAPI
 *    layer — this is the design doc §2's *documented fallback*: the
 *    strict recursive discriminated union below is not flowed into the
 *    OpenAPI generator (recursive `z.lazy` unions do not serialise
 *    cleanly), and the legacy member is intentionally loose anyway.
 *    The strict validation's effective enforcement points — the server
 *    walker (`packages/api/src/renderer/sanitize-ast.ts`) and the iOS
 *    decoder — are unaffected by this choice.
 *
 * 2. **The strict schemas + node registry** (`RenderedAstNodeSchema`,
 *    `RENDERED_AST_NODE_DEFS`, sidecar schemas): the single authority
 *    both the api-side sanitising walker (projection input + post-walk
 *    `.parse()` assertion) and the dispatch sidecar mapper reference.
 *
 * The **legacy branch is unvalidated by contract** (design doc §2): a
 * request that does not declare `X-Crowi-Ast-Version: 1` receives the
 * stored bare mdast `Root` verbatim — no depth / byte / mediaType /
 * base64 / URL-scheme limit is ever applied to it, and
 * `LooseRenderedAstRootSchema` is deliberately NOT an alias of the
 * strict union (third-party `addUnifiedPlugin` / `addNodeRenderer`
 * nodes with arbitrary `type` strings are *expected* in legacy
 * responses). This loose member is permanent for as long as the web
 * client exists (design doc §9).
 */

/** Contract generation of the typed AST wire shape. Single integer, not semver. */
export const CURRENT_AST_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Validation limits (design doc §7). Numeric anchors derive from the
// plugin render cache's shipped limits (SINGLE_ENTRY_REJECT_BYTES = 100KB).
// ---------------------------------------------------------------------------

/**
 * Coarse input-side DoS gate for `sanitizeAst` — measured on the raw
 * stored AST (pre-projection). Also the per-AST component of the
 * save-time revision size guard (design doc §10) so a stored AST can
 * never trip this gate on read.
 */
export const AST_INPUT_LIMIT_BYTES = 8 * 1024 * 1024;
/** Output-side (post-projection) envelope budget — warn threshold. */
export const AST_OUTPUT_WARN_BYTES = 512 * 1024;
/** Output-side (post-projection) envelope budget — node-degrade threshold. Never fails the whole envelope. */
export const AST_OUTPUT_BUDGET_BYTES = 2 * 1024 * 1024;
/** Iterative pre-pass tree depth limit (never rely on zod recursion for this). */
export const AST_MAX_TREE_DEPTH = 64;
/** Iterative pre-pass depth limit for `data.hChildren` hast subtrees. */
export const AST_MAX_HAST_DEPTH = 16;
/** base64 char cap for embedded diagram payloads (≈100KB decoded via the 4/3 expansion). */
export const AST_MAX_IMAGE_BASE64_CHARS = 140_000;
/** Free-form string value cap on wire nodes (`text.value`, `code.value`, `html.value`, TeX source, ...). */
export const AST_MAX_VALUE_CHARS = 200_000;

// ---------------------------------------------------------------------------
// Common `data` (hast hints) — design doc §4.
// ---------------------------------------------------------------------------

/** hast property value: scalars and scalar arrays only (nested objects are structurally excluded). */
const HPropertyValueSchema = z.union([
  z.string().max(4096),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string().max(4096), z.number()])).max(64), // className etc.
]);

/**
 * Bounded `data.hProperties`. Explicit keys cover the shipped
 * producers (heading anchors, emoji a11y, preview scroll-sync, image
 * display attributes); the bounded catchall is the escape valve for
 * future HTML-attribute-like additions. The 4096-char string cap is
 * safe because no shipped producer ever puts a large payload into
 * `hProperties` — base64 diagrams / shiki HTML live inside `html`
 * node *values*, never here.
 */
export const HPropertiesSchema = z
  .object({
    id: z.string().max(256).optional(),
    className: z.union([z.string().max(4096), z.array(z.string().max(256)).max(64)]).optional(),
    role: z.string().max(64).optional(),
    ariaLabel: z.string().max(256).optional(),
    'data-source-line': z.union([z.string().max(32), z.number()]).optional(),
    'data-crowi-image-align': z.string().max(16).optional(),
    'data-crowi-image-float': z.string().max(16).optional(),
    'data-crowi-image-width': z.string().max(16).optional(),
    'data-crowi-image-height': z.string().max(16).optional(),
  })
  .catchall(HPropertyValueSchema);

/** Bounded hast subset allowed inside `data.hChildren` (e.g. remark-emoji's accessible text child). */
export type HChild =
  | { type: 'raw'; value: string }
  | { type: 'text'; value: string }
  | { type: 'element'; tagName: string; properties?: Record<string, unknown>; children: HChild[] };

export const HChildSchema: z.ZodType<HChild> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('raw'), value: z.string().max(AST_MAX_VALUE_CHARS) }),
    z.object({ type: z.literal('text'), value: z.string().max(AST_MAX_VALUE_CHARS) }),
    z.object({
      type: z.literal('element'),
      tagName: z
        .string()
        .max(32)
        .regex(/^[a-zA-Z][a-zA-Z0-9-]*$/),
      properties: HPropertiesSchema.optional(),
      children: z.array(HChildSchema),
    }),
  ]),
) as z.ZodType<HChild>;

export const HChildrenSchema = z.array(HChildSchema).max(256);

export const HNameSchema = z
  .string()
  .max(32)
  .regex(/^[a-zA-Z][a-zA-Z0-9-]*$/);

/** Common `data` every node type may optionally carry (design doc §4). */
export const HastHintDataSchema = z.object({
  hName: HNameSchema.optional(),
  hProperties: HPropertiesSchema.optional(),
  hChildren: HChildrenSchema.optional(),
});
export type HastHintData = z.infer<typeof HastHintDataSchema>;

// ---------------------------------------------------------------------------
// Sidecar payload schemas (design doc §10) — the persisted-AST-internal
// representation stamped onto `html` nodes' `data`, and the sole input
// of the v1 projection. NOT part of the v1 wire contract itself: a
// successful projection replaces the `html` node (sidecar key and all)
// with the corresponding typed node, and a failed one drops the key via
// §4's unlisted-subkey default.
// ---------------------------------------------------------------------------

export const CrowiDimensionSchema = z.number().int().min(1).max(16_384);

export const CrowiImagePayloadSchema = z.object({
  mediaType: z.enum(['image/svg+xml', 'image/png']),
  base64: z.string().max(AST_MAX_IMAGE_BASE64_CHARS),
  /** Intrinsic dimensions — required (parent spec §3). Producers that cannot derive them fall back to html-only. */
  width: CrowiDimensionSchema,
  height: CrowiDimensionSchema,
});
export type CrowiImagePayload = z.infer<typeof CrowiImagePayloadSchema>;

export const ShikiTokenStyleSchema = z.object({
  color: z.string().max(32),
  bgColor: z.string().max(32).optional(),
  fontStyle: z
    .array(z.enum(['italic', 'bold', 'underline', 'strikethrough']))
    .max(4)
    .optional(),
});
export const ShikiTokenSchema = z.object({
  content: z.string().max(4096),
  light: ShikiTokenStyleSchema,
  dark: ShikiTokenStyleSchema,
});
export type ShikiToken = z.infer<typeof ShikiTokenSchema>;

export const ShikiTokenLinesSchema = z.array(z.array(ShikiTokenSchema)).max(20_000);

export const CrowiCodeSidecarSchema = z.object({
  lang: z.string().max(64).optional(),
  value: z.string().max(AST_MAX_VALUE_CHARS),
  /** Lines of themed tokens (light/dark both, `defaultColor: false`). */
  tokens: ShikiTokenLinesSchema,
});
export type CrowiCodeSidecar = z.infer<typeof CrowiCodeSidecarSchema>;

export const CrowiMathSidecarSchema = z.object({
  tex: z.string().max(AST_MAX_VALUE_CHARS),
  display: z.boolean(),
});
export type CrowiMathSidecar = z.infer<typeof CrowiMathSidecarSchema>;

export const CrowiDiagramSidecarSchema = z.object({
  kind: z.enum(['mermaid', 'plantuml']),
  /** Mermaid's closed-enum diagram-type keyword (flowchart / sequence / ...). */
  diagramType: z.string().max(32).optional(),
  alt: z.string().max(256),
  image: CrowiImagePayloadSchema,
});
export type CrowiDiagramSidecar = z.infer<typeof CrowiDiagramSidecarSchema>;

export const CrowiLinkCardSidecarSchema = z.object({
  url: z.string().max(4096),
  title: z.string().max(512).optional(),
  description: z.string().max(2048).optional(),
  /** OGP image stays an external URL (never inlined server-side — parent spec §10). */
  image: z.object({ url: z.string().max(4096) }).optional(),
  siteName: z.string().max(256).optional(),
  domain: z.string().max(256).optional(),
});
export type CrowiLinkCardSidecar = z.infer<typeof CrowiLinkCardSidecarSchema>;

/**
 * The 13 placeholder kinds: the 8 render-error codes + the 2 cache
 * size-limit rejects + the per-run dispatch cap + the 2 validation
 * kinds. `validation-failed` is node-level (a known type failed a value
 * constraint); `envelope-invalid` is the envelope-level collapse
 * (design doc §7) — a distinct kind so clients can tell them apart
 * structurally without special-casing either.
 */
export const CrowiPlaceholderKindSchema = z.enum([
  'error-auth',
  'error-rate-limit',
  'error-not-found',
  'error-network',
  'error-timeout',
  'error-unknown',
  'error-blocked',
  'error-busy',
  'size-limit-entry',
  'size-limit-page',
  'dispatch-limit',
  'validation-failed',
  'envelope-invalid',
]);
export type CrowiPlaceholderKind = z.infer<typeof CrowiPlaceholderKindSchema>;

/** Mirror of `@crowi/plugin-api`'s `Reservation` union (that package must not depend on this one). */
export const ReservationSchema = z.discriminatedUnion('variant', [
  z.object({ variant: z.literal('fixed'), widthPx: z.number().optional(), heightPx: z.number() }),
  z.object({ variant: z.literal('aspect'), aspectRatio: z.number() }),
  z.object({ variant: z.literal('card'), size: z.enum(['small', 'medium', 'large']) }),
]);
export type ReservationShape = z.infer<typeof ReservationSchema>;

export const CrowiPlaceholderSidecarSchema = z.object({
  kind: CrowiPlaceholderKindSchema,
  label: z.string().max(512),
  reservation: ReservationSchema,
});
export type CrowiPlaceholderSidecar = z.infer<typeof CrowiPlaceholderSidecarSchema>;

/** The sidecar keys a producer may stamp on an `html` node's `data`. Exactly one per node. */
export const SIDECAR_KEYS = ['crowiCode', 'crowiMath', 'crowiDiagram', 'crowiLinkCard', 'crowiPlaceholder'] as const;
export type SidecarKey = (typeof SIDECAR_KEYS)[number];

// ---------------------------------------------------------------------------
// Strict per-type node registry (design doc §3 / §6).
//
// `RENDERED_AST_NODE_DEFS` is the closed registry the sanitising walker
// consults: per-type own-field validation (`fields`), where the node may
// appear (`placement`), and what its children are (`childModel`). The
// strict recursive union below is built from the same field schemas so
// walker checks and the post-walk `.parse()` assertion cannot drift.
// ---------------------------------------------------------------------------

/** Where a node may appear. `listItems` / `tableRows` / `tableCells` are the structural positions. */
export type AstPlacement = 'flow' | 'phrasing' | 'both' | 'listItems' | 'tableRows' | 'tableCells';
/** What a node's `children` array contains (`none` = leaf; children are dropped). */
export type AstChildModel = 'flow' | 'phrasing' | 'listItems' | 'tableRows' | 'tableCells' | 'none';

/** Structural view of a zod safeParse the walker consumes without depending on zod generics. */
export interface AstFieldsValidator {
  safeParse(value: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: unknown };
}

export interface RenderedAstNodeDef {
  placement: AstPlacement;
  childModel: AstChildModel;
  /** Own (non-`type` / non-`data` / non-`children`) fields, nullability per `@types/mdast`. */
  fields: AstFieldsValidator;
}

// Field schemas. Nullability mirrors `@types/mdast` (design doc §3:
// `title: string | null`, `listItem.checked: boolean | null`,
// `table.align: AlignType[] | null`, ...) so real parser output
// round-trips verbatim, nulls included.
const noFields = z.object({});
const headingFields = z.object({ depth: z.number().int().min(1).max(6) });
const valueFields = z.object({ value: z.string().max(AST_MAX_VALUE_CHARS) });
const codeFields = z.object({
  value: z.string().max(AST_MAX_VALUE_CHARS),
  lang: z.string().max(64).nullable().optional(),
  meta: z.string().max(1024).nullable().optional(),
});
const mathFields = z.object({
  value: z.string().max(AST_MAX_VALUE_CHARS),
  meta: z.string().max(1024).nullable().optional(),
});
const listFields = z.object({
  ordered: z.boolean().nullable().optional(),
  start: z.number().int().nullable().optional(),
  spread: z.boolean().nullable().optional(),
});
const listItemFields = z.object({
  checked: z.boolean().nullable().optional(),
  spread: z.boolean().nullable().optional(),
});
const linkFields = z.object({
  url: z.string().max(4096),
  title: z.string().max(512).nullable().optional(),
});
const imageFields = z.object({
  url: z.string().max(4096),
  alt: z.string().max(1024).nullable().optional(),
  title: z.string().max(512).nullable().optional(),
});
const tableFields = z.object({
  align: z
    .array(z.enum(['left', 'right', 'center']).nullable())
    .max(256)
    .nullable()
    .optional(),
});
const definitionFields = z.object({
  identifier: z.string().max(256),
  url: z.string().max(4096),
  label: z.string().max(256).optional(),
  title: z.string().max(512).nullable().optional(),
});
const footnoteDefinitionFields = z.object({
  identifier: z.string().max(256),
  label: z.string().max(256).optional(),
});
const footnoteReferenceFields = footnoteDefinitionFields;
const referenceTypeSchema = z.enum(['shortcut', 'collapsed', 'full']);
const linkReferenceFields = z.object({
  identifier: z.string().max(256),
  referenceType: referenceTypeSchema,
  label: z.string().max(256).optional(),
});
const imageReferenceFields = z.object({
  identifier: z.string().max(256),
  referenceType: referenceTypeSchema,
  label: z.string().max(256).optional(),
  alt: z.string().max(1024).nullable().optional(),
});
const crowiOpaqueFields = z.object({
  reason: z.enum(['unknown-type', 'invalid-shape', 'invalid-position']),
  /** Best-effort diagnostics only — never a rendering hint. Truncated to 64 chars before assignment. */
  originalType: z.string().max(64).optional(),
});

// ---------------------------------------------------------------------------
// feature-renderer-frontmatter §D-3 — leading YAML frontmatter, scanned
// (never YAML-parsed, §D-1) into an ordered key/value list. Exported so
// the api-side scanner (`packages/api/src/renderer/core/frontmatter.ts`)
// enforces the SAME numbers the wire schema validates — one constant each,
// never two copies that can drift.
// ---------------------------------------------------------------------------

export const FRONTMATTER_MAX_ENTRIES = 50;
export const FRONTMATTER_MAX_KEY_CHARS = 100;
export const FRONTMATTER_MAX_VALUE_CHARS = 300;
/** Raw frontmatter block size cap. Beyond this the block is never scanned into entries — it is preserved verbatim as a `code` node instead (§D-4). */
export const FRONTMATTER_MAX_RAW_BYTES = 8 * 1024;

export const CrowiFrontmatterEntrySchema = z.object({
  key: z.string().max(FRONTMATTER_MAX_KEY_CHARS),
  value: z.string().max(FRONTMATTER_MAX_VALUE_CHARS),
});
export type CrowiFrontmatterEntry = z.infer<typeof CrowiFrontmatterEntrySchema>;

const crowiFrontmatterFields = z.object({
  entries: z.array(CrowiFrontmatterEntrySchema).max(FRONTMATTER_MAX_ENTRIES),
});

/**
 * The closed type registry (design doc §3). Applies ONLY to
 * `X-Crowi-Ast-Version: 1` envelope generation — legacy responses never
 * consult it, and third-party `x-<plugin>-<type>` nodes are opaque-ised
 * by design (the web keeps rendering them through `mdast-util-to-hast`'s
 * generic `data.hName` fallback on the legacy branch).
 */
export const RENDERED_AST_NODE_DEFS: Readonly<Record<string, RenderedAstNodeDef>> = {
  root: { placement: 'flow', childModel: 'flow', fields: noFields },
  paragraph: { placement: 'flow', childModel: 'phrasing', fields: noFields },
  heading: { placement: 'flow', childModel: 'phrasing', fields: headingFields },
  thematicBreak: { placement: 'flow', childModel: 'none', fields: noFields },
  blockquote: { placement: 'flow', childModel: 'flow', fields: noFields },
  list: { placement: 'flow', childModel: 'listItems', fields: listFields },
  listItem: { placement: 'listItems', childModel: 'flow', fields: listItemFields },
  html: { placement: 'both', childModel: 'none', fields: valueFields },
  code: { placement: 'flow', childModel: 'none', fields: codeFields },
  inlineCode: { placement: 'phrasing', childModel: 'none', fields: valueFields },
  math: { placement: 'flow', childModel: 'none', fields: mathFields },
  inlineMath: { placement: 'phrasing', childModel: 'none', fields: mathFields },
  text: { placement: 'phrasing', childModel: 'none', fields: valueFields },
  strong: { placement: 'phrasing', childModel: 'phrasing', fields: noFields },
  emphasis: { placement: 'phrasing', childModel: 'phrasing', fields: noFields },
  delete: { placement: 'phrasing', childModel: 'phrasing', fields: noFields },
  break: { placement: 'phrasing', childModel: 'none', fields: noFields },
  link: { placement: 'phrasing', childModel: 'phrasing', fields: linkFields },
  image: { placement: 'phrasing', childModel: 'none', fields: imageFields },
  table: { placement: 'flow', childModel: 'tableRows', fields: tableFields },
  tableRow: { placement: 'tableRows', childModel: 'tableCells', fields: noFields },
  tableCell: { placement: 'tableCells', childModel: 'phrasing', fields: noFields },
  definition: { placement: 'flow', childModel: 'none', fields: definitionFields },
  footnoteDefinition: { placement: 'flow', childModel: 'flow', fields: footnoteDefinitionFields },
  footnoteReference: { placement: 'phrasing', childModel: 'none', fields: footnoteReferenceFields },
  linkReference: { placement: 'phrasing', childModel: 'phrasing', fields: linkReferenceFields },
  imageReference: { placement: 'phrasing', childModel: 'none', fields: imageReferenceFields },
  // Crowi-owned types. `crowiFigure` / `crowiFrontmatter` are the only
  // ones that also appear in stored ASTs directly (a core transform
  // writes them at save time); the other three only exist as projection
  // outputs (or as defensively-validated plugin-injected nodes).
  crowiFigure: { placement: 'flow', childModel: 'phrasing', fields: noFields },
  crowiFrontmatter: { placement: 'flow', childModel: 'none', fields: crowiFrontmatterFields },
  crowiDiagram: { placement: 'flow', childModel: 'none', fields: CrowiDiagramSidecarSchema },
  crowiLinkCard: { placement: 'flow', childModel: 'none', fields: CrowiLinkCardSidecarSchema },
  crowiPlaceholder: { placement: 'both', childModel: 'none', fields: CrowiPlaceholderSidecarSchema },
  crowiOpaque: { placement: 'both', childModel: 'none', fields: crowiOpaqueFields },
};

// ---------------------------------------------------------------------------
// Strict recursive wire union — `type`-discriminated (design doc §3).
// Children arrays are typed as the generic node union: block/phrasing
// placement is the WALKER's responsibility (parent-content-model
// argument, §5 step 2), so the post-walk `.parse()` stays a pure
// type-safety assertion rather than a second content-model check. This
// also lets the §7 output-budget trimmer substitute `crowiPlaceholder`
// nodes at structural positions (list/table children) without failing
// the assertion.
// ---------------------------------------------------------------------------

/** A validated v1 wire node. Loose TS view; the runtime shape is pinned by the schema. */
export type RenderedAstNode = { type: string } & Record<string, unknown>;

export const RenderedAstNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    RootNodeSchema,
    ParagraphNodeSchema,
    HeadingNodeSchema,
    ThematicBreakNodeSchema,
    BlockquoteNodeSchema,
    ListNodeSchema,
    ListItemNodeSchema,
    HtmlNodeSchema,
    CodeNodeSchema,
    InlineCodeNodeSchema,
    MathNodeSchema,
    InlineMathNodeSchema,
    TextNodeSchema,
    StrongNodeSchema,
    EmphasisNodeSchema,
    DeleteNodeSchema,
    BreakNodeSchema,
    LinkNodeSchema,
    ImageNodeSchema,
    TableNodeSchema,
    TableRowNodeSchema,
    TableCellNodeSchema,
    DefinitionNodeSchema,
    FootnoteDefinitionNodeSchema,
    FootnoteReferenceNodeSchema,
    LinkReferenceNodeSchema,
    ImageReferenceNodeSchema,
    CrowiFigureNodeSchema,
    CrowiFrontmatterNodeSchema,
    CrowiDiagramNodeSchema,
    CrowiLinkCardNodeSchema,
    CrowiPlaceholderNodeSchema,
    CrowiOpaqueNodeSchema,
  ]),
);

const childrenSchema = z.array(RenderedAstNodeSchema);
const dataSchema = HastHintDataSchema.optional();

const RootNodeSchema = z.object({ type: z.literal('root'), data: dataSchema, children: childrenSchema });
const ParagraphNodeSchema = z.object({ type: z.literal('paragraph'), data: dataSchema, children: childrenSchema });
const HeadingNodeSchema = headingFields.extend({ type: z.literal('heading'), data: dataSchema, children: childrenSchema });
const ThematicBreakNodeSchema = z.object({ type: z.literal('thematicBreak'), data: dataSchema });
const BlockquoteNodeSchema = z.object({ type: z.literal('blockquote'), data: dataSchema, children: childrenSchema });
const ListNodeSchema = listFields.extend({ type: z.literal('list'), data: dataSchema, children: childrenSchema });
const ListItemNodeSchema = listItemFields.extend({ type: z.literal('listItem'), data: dataSchema, children: childrenSchema });
const HtmlNodeSchema = valueFields.extend({ type: z.literal('html'), data: dataSchema });
/** `code` may additionally carry `renderPending` (dispatch retry marker) and projected `tokens` on `data`. */
const CodeDataSchema = HastHintDataSchema.extend({
  renderPending: z.boolean().optional(),
  tokens: ShikiTokenLinesSchema.optional(),
}).optional();
const CodeNodeSchema = codeFields.extend({ type: z.literal('code'), data: CodeDataSchema });
const InlineCodeNodeSchema = valueFields.extend({ type: z.literal('inlineCode'), data: dataSchema });
const MathNodeSchema = mathFields.extend({ type: z.literal('math'), data: dataSchema });
const InlineMathNodeSchema = mathFields.extend({ type: z.literal('inlineMath'), data: dataSchema });
const TextNodeSchema = valueFields.extend({ type: z.literal('text'), data: dataSchema });
const StrongNodeSchema = z.object({ type: z.literal('strong'), data: dataSchema, children: childrenSchema });
const EmphasisNodeSchema = z.object({ type: z.literal('emphasis'), data: dataSchema, children: childrenSchema });
const DeleteNodeSchema = z.object({ type: z.literal('delete'), data: dataSchema, children: childrenSchema });
const BreakNodeSchema = z.object({ type: z.literal('break'), data: dataSchema });
const LinkNodeSchema = linkFields.extend({ type: z.literal('link'), data: dataSchema, children: childrenSchema });
const ImageNodeSchema = imageFields.extend({ type: z.literal('image'), data: dataSchema });
const TableNodeSchema = tableFields.extend({ type: z.literal('table'), data: dataSchema, children: childrenSchema });
const TableRowNodeSchema = z.object({ type: z.literal('tableRow'), data: dataSchema, children: childrenSchema });
const TableCellNodeSchema = z.object({ type: z.literal('tableCell'), data: dataSchema, children: childrenSchema });
const DefinitionNodeSchema = definitionFields.extend({ type: z.literal('definition'), data: dataSchema });
const FootnoteDefinitionNodeSchema = footnoteDefinitionFields.extend({
  type: z.literal('footnoteDefinition'),
  data: dataSchema,
  children: childrenSchema,
});
const FootnoteReferenceNodeSchema = footnoteReferenceFields.extend({ type: z.literal('footnoteReference'), data: dataSchema });
const LinkReferenceNodeSchema = linkReferenceFields.extend({ type: z.literal('linkReference'), data: dataSchema, children: childrenSchema });
const ImageReferenceNodeSchema = imageReferenceFields.extend({ type: z.literal('imageReference'), data: dataSchema });
/** `crowiFigure` (image-attrs, shipped): `data.hName` pinned to 'figure', `hProperties` required. */
const CrowiFigureNodeSchema = z.object({
  type: z.literal('crowiFigure'),
  data: HastHintDataSchema.extend({ hName: z.literal('figure'), hProperties: HPropertiesSchema }),
  children: childrenSchema,
});
/** `crowiFrontmatter` (feature-renderer-frontmatter, shipped): ordered key/value entries, no children (values are never re-parsed as Markdown, §D-5). */
const CrowiFrontmatterNodeSchema = crowiFrontmatterFields.extend({ type: z.literal('crowiFrontmatter'), data: dataSchema });
export const CrowiDiagramNodeSchema = CrowiDiagramSidecarSchema.extend({ type: z.literal('crowiDiagram'), data: dataSchema });
export const CrowiLinkCardNodeSchema = CrowiLinkCardSidecarSchema.extend({ type: z.literal('crowiLinkCard'), data: dataSchema });
export const CrowiPlaceholderNodeSchema = CrowiPlaceholderSidecarSchema.extend({ type: z.literal('crowiPlaceholder'), data: dataSchema });
export const CrowiOpaqueNodeSchema = crowiOpaqueFields.extend({ type: z.literal('crowiOpaque'), data: dataSchema });

export const RenderedAstRootSchema = RootNodeSchema;

/**
 * The strict v1 envelope: what `sanitizeAst` produces and what the iOS
 * decoder consumes. NOT flowed into OpenAPI (see the module doc
 * comment's fallback note); the OpenAPI representation of the envelope
 * is `RenderedAstEnvelopeOpenApiSchema` below.
 */
export const RenderedAstEnvelopeSchema = z.object({
  astVersion: z.literal(CURRENT_AST_VERSION),
  root: RenderedAstRootSchema,
});

// ---------------------------------------------------------------------------
// OpenAPI-facing wire union (design doc §2 + §9).
// ---------------------------------------------------------------------------

/** OpenAPI representation of the v1 envelope (documented fallback: `root` stays loose at this layer). */
export const RenderedAstEnvelopeOpenApiSchema = z
  .object({
    astVersion: z.literal(CURRENT_AST_VERSION),
    root: z.unknown(),
  })
  .openapi('RenderedAstEnvelope');

/**
 * The shape the declaration-less (legacy) branch actually returns:
 * the stored bare mdast `Root`, verbatim and **unvalidated**.
 * Intentionally loose and intentionally NOT an alias of the strict
 * union — see the module doc comment.
 */
export const LooseRenderedAstRootSchema = z
  .object({
    type: z.literal('root'),
    children: z.array(z.unknown()),
  })
  .openapi('LegacyRenderedAstRoot');

/** What `renderedAst` response fields carry: v1 envelope (declared clients) or bare Root (everyone else). */
export const RenderedAstValueSchema = z.union([RenderedAstEnvelopeOpenApiSchema, LooseRenderedAstRootSchema]);
export type RenderedAstValue = z.infer<typeof RenderedAstValueSchema>;

/**
 * Response-identity key for the served AST artifact (design doc §14):
 * `rendererVersion` when the stored AST was served verbatim, a
 * per-response nonce when the tree was modified (pending-marker retry)
 * or recomputed (freshness mismatch). The web render memo keys on
 * `[revisionId, renderedAstArtifactKey]`.
 */
export const RenderedAstArtifactKeySchema = z.string().max(64);

// ---------------------------------------------------------------------------
// Defensive shape normaliser (design doc §14) — the single accessor the
// web routes every `renderedAst` read through.
// ---------------------------------------------------------------------------

/**
 * Unwrap a `renderedAst` response value to a bare mdast-`Root`-shaped
 * object, or `undefined` when there is nothing renderable.
 *
 * In normal operation the web always receives the bare Root branch —
 * the envelope branch is pure belt-and-suspenders against a future
 * header-emitting mistake or a misconfigured reverse cache.
 */
export function unwrapRenderedAst(value: unknown): unknown | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return undefined;
  if ((value as { astVersion?: unknown }).astVersion === CURRENT_AST_VERSION) {
    const root = (value as { root?: unknown }).root;
    return root === null ? undefined : root;
  }
  if ((value as { type?: unknown }).type === 'root' && Array.isArray((value as { children?: unknown }).children)) {
    return value;
  }
  return undefined;
}

/** Strict envelope type (walker output / decoder input). */
export interface RenderedAstEnvelope {
  astVersion: typeof CURRENT_AST_VERSION;
  root: { type: 'root'; children: unknown[] } & Record<string, unknown>;
}
