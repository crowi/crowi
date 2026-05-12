import type { Link, PhrasingContent, Text } from 'mdast';
import type { WikiLinkResponse } from '@crowi/api-contract';
import type { PipelineMetadata } from '../pipeline';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform — detect `[[…]]` inside text nodes, replace
 * them with link nodes (so downstream renderers see proper links),
 * and push canonical entries into `metadata.wikiLinks`.
 *
 * Supported shapes:
 *   - `[[Page]]`              → link to `Page`, display `Page`
 *   - `[[/path/to/page]]`     → link to `/path/to/page`, display same
 *   - `[[Page|Display]]`      → link to `Page`, display `Display`
 *   - `[[Page#section]]`      → link to `Page#section`, display `Page#section`
 *
 * Targets that don't start with `/` are kept as-is (Phase 3 will add
 * resolved-wikilink endpoint to map names to paths). The link node
 * carries `data.hProperties.className = 'wikilink-broken'` for
 * non-absolute targets so the web renderer can dim them. `javascript:`
 * and external `http(s)://` targets are stripped to broken-link too —
 * they are never valid wikilink targets.
 *
 * The walker only descends into text nodes; code blocks and inline
 * code (`code`, `inlineCode`) are skipped, matching the spec.
 */

// `[[…]]` capture. Disallow newlines and unbalanced brackets inside.
// Greedy on the body but bounded to a reasonable length so a stray
// `[[` doesn't eat the rest of the document.
const WIKILINK_RE = /\[\[([^[\]\n]{1,256})\]\]/g;

export const remarkWikiLinks: UnifiedTransformPlugin = (metadata) => (tree) => {
  walk(tree);

  function walk(node: { type?: string; children?: unknown[] }): void {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (Array.isArray(node.children)) {
      const replaced = transformChildren(node.children as PhrasingContent[], metadata);
      node.children = replaced;
      for (const child of replaced) walk(child as { type?: string; children?: unknown[] });
    }
  }
};

function transformChildren(children: PhrasingContent[], metadata: PipelineMetadata): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    if (child.type !== 'text') {
      out.push(child);
      continue;
    }
    const expanded = expandText(child as Text, metadata);
    out.push(...expanded);
  }
  return out;
}

function expandText(textNode: Text, metadata: PipelineMetadata): PhrasingContent[] {
  const value = textNode.value;
  if (!value || !value.includes('[[')) return [textNode];

  const out: PhrasingContent[] = [];
  let lastIndex = 0;
  WIKILINK_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = WIKILINK_RE.exec(value)); ) {
    const [matched, raw] = m;
    const start = m.index;
    if (start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    const parsed = parseWikiLink(raw);
    metadata.wikiLinks.push(parsed);
    out.push(toLinkNode(parsed));
    lastIndex = start + matched.length;
  }
  if (lastIndex === 0) return [textNode];
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function parseWikiLink(raw: string): WikiLinkResponse {
  const trimmed = raw.trim();
  const pipeAt = trimmed.indexOf('|');
  if (pipeAt >= 0) {
    return {
      raw,
      target: trimmed.slice(0, pipeAt).trim(),
      displayText: trimmed.slice(pipeAt + 1).trim(),
    };
  }
  return { raw, target: trimmed };
}

function toLinkNode(entry: WikiLinkResponse): Link {
  const display = entry.displayText ?? entry.target;
  const isValid = isValidTarget(entry.target);
  const data: { hProperties?: Record<string, unknown> } = {};
  if (!isValid) {
    data.hProperties = { className: 'wikilink-broken' };
  }
  return {
    type: 'link',
    url: isValid ? entry.target : '#',
    title: null,
    children: [{ type: 'text', value: display }],
    data,
  };
}

/**
 * Phase 2 valid-target rule: target must start with `/` (absolute
 * path). Anything else (bare name, external URL, `javascript:`) gets
 * `wikilink-broken` and a `#` href so it's visually distinct without
 * leaving the page.
 */
function isValidTarget(target: string): boolean {
  if (!target) return false;
  return target.startsWith('/');
}
