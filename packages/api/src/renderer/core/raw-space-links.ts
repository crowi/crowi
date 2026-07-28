import type { Link, PhrasingContent, Text } from 'mdast';
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
 * Grammar (bounded, intentionally simplified — NOT CommonMark-complete):
 *   - `[label](/destination)` only: destination MUST start with `/`
 *     (absolute path; external URLs / relative paths are out of scope)
 *   - no newline, no nested `(`/`)` in either label or destination
 *   - no title syntax (`(/a b "title")`) — a `"` in the captured
 *     destination looks like an unsupported title continuation, so the
 *     whole match is left as literal text rather than guess at a wrong
 *     URL
 *   - the destination must contain a literal space — anything without
 *     one would already have parsed as an ordinary link (unless nested
 *     inside an existing link, guarded separately below)
 *   - image syntax (`![alt](/a b)`) is excluded: an unescaped `!`
 *     immediately before the `[` disqualifies the match, since a raw-
 *     space destination fails to parse as either a link OR an image
 *     for the exact same CommonMark reason
 *   - a directly-preceding backslash (`\[label\](/a b)`) disqualifies
 *     the match — see the escape-detection note below
 *
 * Recovered `link` nodes carry `data.rawSpaceRecovered = true`.
 * `Backlink.createBySavedPage` (`packages/api/src/models/backlink.ts`)
 * walks the saved `renderedAst` for this marker to extract backlinks
 * from these links — deliberately NOT a new `linkDetector` regex
 * pattern, which would match raw-space tokens inside code fences too
 * (this transform never descends into `code`/`inlineCode`, so those
 * never become `link` nodes here in the first place — see the walker
 * note below).
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

interface GrammarMatch {
  /** Index in the scanned string where the match (`[`) starts. */
  start: number;
  /** Index (exclusive) where the match (closing `)`) ends. */
  end: number;
  label: string;
  destination: string;
}

// `[label](/destination)`: label has no `]`/newline (mirrors
// `wikilinks.ts`'s `WIKILINK_RE` bound); destination starts with `/`,
// has no `(`/`)`/newline (nested parens unsupported — simplification,
// not CommonMark-complete). Bounds on both capture groups keep a
// pathological run of unmatched brackets from a runaway scan.
const RAW_SPACE_LINK_RE = /\[([^[\]\n]{1,512})\]\((\/[^()\n]{1,2048})\)/g;

function findGrammarMatches(source: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  RAW_SPACE_LINK_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = RAW_SPACE_LINK_RE.exec(source)); ) {
    const [matched, label, destination] = m;
    out.push({ start: m.index, end: m.index + matched.length, label, destination });
  }
  return out;
}

/** Grammar-level filters that are representation-independent (checked against the de-escaped `.value` match). */
function isRecoverableCandidate(source: string, match: GrammarMatch): boolean {
  // Image syntax guard: `![alt](/a b)` stays literal text.
  if (match.start > 0 && source[match.start - 1] === '!') return false;
  // Only a genuinely raw-space destination is in scope.
  if (!match.destination.includes(' ')) return false;
  // A `"` looks like an unsupported title continuation
  // (`(/a b "title")`) — bail out rather than guess at a wrong URL.
  if (match.destination.includes('"')) return false;
  return true;
}

function isEscapedAt(rawSource: string, matchStart: number): boolean {
  return matchStart > 0 && rawSource[matchStart - 1] === '\\';
}

function rawSliceFor(node: Text, body: string): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  return body.slice(start, end);
}

function toRecoveredLinkNode(match: GrammarMatch): Link {
  const data: { rawSpaceRecovered: true } = { rawSpaceRecovered: true };
  return {
    type: 'link',
    url: match.destination,
    title: null,
    children: [{ type: 'text', value: match.label }],
    data,
  };
}

function expandText(textNode: Text, body: string): PhrasingContent[] {
  const value = textNode.value;
  if (!value || !value.includes('](/')) return [textNode];

  const valueMatches = findGrammarMatches(value);
  if (valueMatches.length === 0) return [textNode];

  const rawSlice = rawSliceFor(textNode, body);
  const rawMatches = rawSlice !== undefined ? findGrammarMatches(rawSlice) : [];

  let anyRecovered = false;
  const decisions = valueMatches.map((match, i) => {
    if (!isRecoverableCandidate(value, match)) return false;
    const rawMatch = rawMatches[i];
    const escaped = rawSlice !== undefined && rawMatch !== undefined && isEscapedAt(rawSlice, rawMatch.start);
    const recover = !escaped;
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
    out.push(decisions[i] ? toRecoveredLinkNode(match) : { type: 'text', value: value.slice(match.start, match.end) });
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
  (_metadata) =>
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
        out.push(...expandText(child as Text, body));
      }
      return out;
    }
  };
