import { isRawSpaceLinkRecoverable, type RawSpaceLinkMatch, scanRawSpaceLinkGrammar } from '@crowi/api-contract';
import type { Link, PhrasingContent, Text } from 'mdast';
import type { PipelineMetadata } from '../pipeline';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform (feature-page-link-space-paths Phase 2) —
 * recovers `[label](/absolute path with spaces)` into a proper mdast
 * `link` node. CommonMark's standard (non-angle-bracket) link
 * destination grammar rejects a raw, unescaped ASCII space, so
 * `remark-parse` leaves this shape as literal `text` instead of a
 * `link` node (see `pipeline.test.ts`'s Phase 1 "does NOT parse a
 * raw-space destination" pin). This transform is a deliberate,
 * narrow **CommonMark deviation** — not a parser fix — that turns an
 * author's likely-unintentional literal text back into a clickable
 * internal link. Full rationale:
 * `.feature-state/specs/feature-page-link-space-paths.md` §"設計の主な
 * 判断"/Phase 2.
 *
 * The grammar and the accept/reject rules (image `!`, no space, `"`, `\` escape)
 * are defined once in `@crowi/api-contract`'s `util/page-path.ts`, shared with
 * the editor's highlighting.
 *
 * Every recovered link's verbatim `url` (destination) is pushed onto
 * `metadata.rawSpaceLinks` (feature-backlink-raw-space-metadata) — the
 * exact same "core transform pushes into the run's `PipelineMetadata`
 * bag" shape `wikilinks.ts`'s `remarkWikiLinks` uses for
 * `metadata.wikiLinks`. That bag is persisted verbatim onto
 * `revision.meta` (`models/revision.ts`'s `metadataToRevisionMeta`).
 * `Backlink.createBySavedPage` (`packages/api/src/models/backlink.ts`)
 * reads `savedPage.revision.meta.rawSpaceLinks` directly — deliberately
 * NOT a new `linkDetector` regex pattern, which would match raw-space
 * tokens inside code fences too (this transform never descends into
 * `code`/`inlineCode`, so those never contribute a `rawSpaceLinks` entry
 * in the first place — see the walker note below). An earlier revision
 * of this transform stamped a `data.rawSpaceRecovered = true` marker on
 * the recovered `link` node instead, and `Backlink.createBySavedPage`
 * found it by walking the whole saved `renderedAst` on every save; the
 * metadata channel above replaces that (see
 * `.feature-state/specs/feature-backlink-raw-space-metadata.md`) — no
 * `data` marker is stamped on the link node anymore.
 *
 * Walker: mirrors `wikilinks.ts`'s walk-and-expand pattern (never
 * descends into `code`/`inlineCode`), with one addition — it also
 * never descends into an existing `link` / `linkReference` node's
 * children. Without that guard, a raw-space fragment already nested
 * inside another link's label (`[outer [x](/a b)](/dest)` — CommonMark
 * disallows nested links, so `[x](/a b)` survives as literal text
 * *inside* the outer link's label) would get "recovered" into a
 * `link` nested inside a `link`, which is both structurally invalid
 * mdast and never something CommonMark itself produces.
 *
 * Escape detection: `remark-parse` resolves a backslash escape
 * (`\[` → `[`) at parse time, so the resulting `text` node's `.value`
 * never contains the backslash — but its `.position` still spans the
 * RAW source range, backslash included (verified empirically: `[label
 * ](/a b)` and `\[label\](/a b)` produce the identical merged
 * `.value: '[label](/a b)'`, but the escaped form's
 * `position.end.offset` is larger by exactly the 2 escaped
 * characters). This transform takes the `body` string (bound at
 * `buildCorePlugins`/`runPipeline` call time — see `core/index.ts`)
 * and, for each text node, re-slices the RAW source
 * (`body.slice(position.start.offset, position.end.offset)`) and
 * re-runs the SAME grammar against it purely to check whether the
 * character immediately before a candidate match is a literal `\` —
 * if so, the match is left as literal text. Matches are correlated
 * between the de-escaped `.value` and the raw slice by ordinal
 * position (Nth match in each), NOT by translating offsets — a single
 * merged text node can contain other, unrelated escapes earlier in
 * the same run, which shift `.value` and raw offsets apart by 2
 * characters per escape, so a naive index translation would drift.
 * Ordinal correlation is a deliberate simplification (rare edge cases
 * like a raw-body match count that doesn't equal the value-based
 * match count — e.g. via character references — are not specially
 * handled) that is sufficient to catch the direct-escape case
 * `\[label\](/a b)`; it does not attempt to resolve double-escaping
 * (`\\[label\\]`) or other compound CommonMark escape interactions
 * (see spec's "やらないこと").
 */

function rawSliceFor(node: Text, body: string): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  return body.slice(start, end);
}

function toRecoveredLinkNode(match: RawSpaceLinkMatch): Link {
  return {
    type: 'link',
    url: match.destination,
    title: null,
    children: [{ type: 'text', value: match.label }],
  };
}

function expandText(textNode: Text, body: string, metadata: PipelineMetadata): PhrasingContent[] {
  const value = textNode.value;
  if (!value || !value.includes('](/')) return [textNode];

  const valueMatches = scanRawSpaceLinkGrammar(value);
  if (valueMatches.length === 0) return [textNode];

  const rawSlice = rawSliceFor(textNode, body);
  const rawMatches = rawSlice !== undefined ? scanRawSpaceLinkGrammar(rawSlice) : [];

  let anyRecovered = false;
  const decisions = valueMatches.map((match, i) => {
    const rawMatch = rawMatches[i];
    const raw = rawSlice !== undefined && rawMatch !== undefined ? { source: rawSlice, start: rawMatch.start } : undefined;
    const recover = isRawSpaceLinkRecoverable(value, match, raw);
    if (recover) anyRecovered = true;
    return recover;
  });

  // No candidate ended up recoverable (all filtered out or escaped) —
  // return the ORIGINAL node untouched rather than a re-sliced
  // byte-identical copy, matching `wikilinks.ts`'s
  // `if (lastIndex === 0) return [textNode];` precedent.
  if (!anyRecovered) return [textNode];

  const out: PhrasingContent[] = [];
  let lastIndex = 0;
  valueMatches.forEach((match, i) => {
    if (match.start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, match.start) });
    }
    if (decisions[i]) {
      // Same "push into the run's metadata bag" step `remarkWikiLinks`
      // does for `metadata.wikiLinks` — the verbatim (not yet decoded)
      // destination, so `Backlink.createBySavedPage` can apply the exact
      // same `stripFragmentAndQuery` -> `decodeLinkPath` pipeline the
      // regex-based extraction path uses.
      metadata.rawSpaceLinks.push(match.destination);
      out.push(toRecoveredLinkNode(match));
    } else {
      out.push({ type: 'text', value: value.slice(match.start, match.end) });
    }
    lastIndex = match.end;
  });
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

/**
 * Factory bound to the run's raw `body` (needed for the raw-slice
 * escape check above). Slots into `buildCorePlugins` right after
 * `makeRemarkHeadings` and BEFORE `remarkImageAttrs` — deliberately
 * the first content-rewriting core transform, so it always sees
 * pristine `text` nodes straight from `processor.parse(body)` with
 * accurate `position` offsets (later transforms like `remarkImageAttrs`
 * mutate a text node's `.value` in place without updating its
 * `.position`, which would desync the raw-slice escape check for any
 * transform running after it — see `core/index.ts`'s "Order
 * rationale").
 */
export const makeRawSpaceLinkRecovery =
  (body: string): UnifiedTransformPlugin =>
  (metadata) =>
  (tree) => {
    walk(tree);

    function walk(node: { type?: string; children?: unknown[] }): void {
      if (node.type === 'code' || node.type === 'inlineCode') return;
      // Never recover inside an existing `link` / `linkReference` —
      // see the walker note in the file header.
      if (node.type === 'link' || node.type === 'linkReference') return;
      if (Array.isArray(node.children)) {
        const replaced = transformChildren(node.children as PhrasingContent[]);
        node.children = replaced;
        for (const child of replaced) walk(child as { type?: string; children?: unknown[] });
      }
    }

    function transformChildren(children: PhrasingContent[]): PhrasingContent[] {
      const out: PhrasingContent[] = [];
      for (const child of children) {
        if (child.type !== 'text') {
          out.push(child);
          continue;
        }
        out.push(...expandText(child as Text, body, metadata));
      }
      return out;
    }
  };
