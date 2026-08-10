import { FRONTMATTER_MAX_ENTRIES, FRONTMATTER_MAX_KEY_CHARS, FRONTMATTER_MAX_RAW_BYTES, FRONTMATTER_MAX_VALUE_CHARS } from '@crowi/api-contract';
import type { Root, RootContent } from 'mdast';
import type { Position } from 'unist';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform — feature-renderer-frontmatter §D-3/§D-4.
 *
 * `remark-frontmatter` (a parser extension applied in `pipeline.ts`,
 * §D-2) turns a document-leading `---` block into a single `yaml` mdast
 * node instead of a `thematicBreak` + paragraph. This transform is the
 * first core plugin (`core/index.ts`) — before any other transform can
 * see the tree — and replaces that `yaml` node with either:
 *
 *   - `crowiFrontmatter` (§D-5): the raw text scanned into an ordered
 *     `{key, value}[]` list, when at least one entry was found and every
 *     limit is satisfied.
 *   - `code` (`lang: 'yaml'`, §D-4): the raw text preserved verbatim,
 *     when the block is over any limit or nothing scannable was found.
 *     Content is never dropped or truncated — a limit violation only
 *     ever changes HOW the block is displayed, never loses its bytes.
 *   - removed entirely, when the raw text is empty (`---` immediately
 *     followed by `---`) — nothing to display.
 *
 * Deliberately NOT a YAML parser (§D-1): this is a line-oriented scan
 * for "what's on the left, what's on the right", so there is no anchor/
 * alias expansion surface (YAML bomb) to worry about, no matter how the
 * frontmatter block is shaped.
 *
 * A document-MID `---` is unaffected by any of this — `remark-frontmatter`
 * itself only recognises frontmatter at the very start of the document
 * (line 1), so a later `---` still parses as an ordinary `thematicBreak`
 * and never reaches this transform as a `yaml` node.
 */

/** Indent-0 `key: value` line — group 1 is the key, group 2 is the (possibly empty) value. */
const ENTRY_LINE_RE = /^([^:\s][^:]*):[ \t]*(.*)$/;

interface ScannedEntry {
  key: string;
  value: string;
}

/**
 * §D-3 scan: split into lines, start a new entry on every indent-0
 * `key: value` line, and fold every other line (indented, `- `-prefixed,
 * colon-less, or blank) into the PREVIOUS entry's value joined by a
 * single space — discarded if there is no previous entry yet. Key/value
 * whitespace is trimmed once the whole block has been walked.
 */
function scanEntries(raw: string): ScannedEntry[] {
  const entries: ScannedEntry[] = [];
  let current: ScannedEntry | null = null;

  for (const line of raw.split(/\r\n|\r|\n/)) {
    // Indent 0 = the line does not start with a space/tab. Only an
    // indent-0 line can ever start a new entry (§D-3 step 2) — but a
    // `- `-prefixed line is a continuation UNCONDITIONALLY (AC-3), even
    // at indent 0 and even when it itself contains a colon (a YAML
    // list-of-mappings line like `- name: value`): otherwise it would
    // match ENTRY_LINE_RE and spawn a spurious `- name` entry instead
    // of folding into the list's key.
    const indented = line.length > 0 && (line[0] === ' ' || line[0] === '\t');
    const isListMarker = line.startsWith('- ') || line === '-';
    const match = indented || isListMarker ? null : ENTRY_LINE_RE.exec(line);
    if (match) {
      current = { key: match[1], value: match[2] };
      entries.push(current);
      continue;
    }
    if (!current) continue; // no entry open yet — discard (§D-3 step 3)
    // "空白1個で連結する" (§D-3 step 3) is a NORMALIZED single-space join —
    // the continuation line's own indentation must not leak into the
    // joined value as extra spaces, so it is trimmed before joining.
    current.value = `${current.value} ${line.trim()}`;
  }

  return entries.map((entry) => ({ key: entry.key.trim(), value: entry.value.trim() }));
}

/** §D-3's table, applied to the TRIMMED entries — a limit violation anywhere routes the whole block to the §D-4 code-block fallback. */
function withinLimits(entries: ScannedEntry[]): boolean {
  if (entries.length === 0 || entries.length > FRONTMATTER_MAX_ENTRIES) return false;
  return entries.every((entry) => entry.key.length <= FRONTMATTER_MAX_KEY_CHARS && entry.value.length <= FRONTMATTER_MAX_VALUE_CHARS);
}

/** The shape `remark-frontmatter` (`mdast-util-frontmatter`) produces for a `['yaml']`-enabled fence — a `Literal`-like leaf carrying the raw text between the markers (delimiters and one leading/trailing EOL already stripped). */
interface YamlNode {
  type: 'yaml';
  value: string;
  position?: Position;
}

function isYamlNode(node: RootContent): node is YamlNode & RootContent {
  return node.type === 'yaml';
}

/**
 * Build the replacement node for one `yaml` node, or `null` when it
 * should be removed outright (empty raw text — §D-3 step 7).
 *
 * `position` is copied onto the replacement (mirroring
 * `image-attrs.ts`'s `crowiFigure`) so the editor preview's
 * `data-source-line` scroll-sync anchor (`page-preview.ts`'s
 * `injectSourceLineAnchors`, keyed off each top-level node's
 * `position.start.line`) still resolves for the frontmatter block —
 * `serializeMdast` strips `position` again before persistence, so this
 * has no effect on the stored shape.
 */
function replaceYamlNode(node: YamlNode): RootContent | null {
  const raw = node.value;
  if (raw === '') return null; // §D-3 step 7 — nothing to display

  if (Buffer.byteLength(raw, 'utf8') > FRONTMATTER_MAX_RAW_BYTES) {
    return codeFallback(raw, node.position);
  }

  const entries = scanEntries(raw);
  if (!withinLimits(entries)) {
    // Either zero entries were scannable (§D-3 step 3 discarded
    // everything, or step 2 never matched) or a per-entry/count limit
    // was exceeded — both fall back to the code block verbatim (§D-4).
    return codeFallback(raw, node.position);
  }

  return {
    type: 'crowiFrontmatter',
    entries,
    ...(node.position ? { position: node.position } : {}),
  } as unknown as RootContent;
}

function codeFallback(raw: string, position: Position | undefined): RootContent {
  return {
    type: 'code',
    lang: 'yaml',
    meta: null,
    value: raw,
    ...(position ? { position } : {}),
  } as unknown as RootContent;
}

/**
 * `makeFrontmatterPlugin` doesn't need the shared `metadata` bag (nothing
 * to aggregate — contrast `remarkCodeBlockLanguages`), but keeps the
 * standard `UnifiedTransformPlugin` factory shape so it slots into
 * `buildCorePlugins` identically to every other core transform. Runs
 * FIRST in that list (`core/index.ts`) so no later transform — including
 * `remarkBreaks` — ever sees a `yaml` node.
 */
export const makeFrontmatterPlugin: UnifiedTransformPlugin = (_metadata) => (tree: Root) => {
  const out: RootContent[] = [];
  for (const child of tree.children) {
    if (!isYamlNode(child)) {
      out.push(child);
      continue;
    }
    const replacement = replaceYamlNode(child);
    if (replacement) out.push(replacement);
  }
  tree.children = out;
};
