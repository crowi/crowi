import type { Heading, Paragraph, PhrasingContent, Root } from 'mdast';
import type { CrowiPlugin } from '@crowi/plugin-api';

/**
 * Match a v1-style ATX heading missing the spec-required space after
 * the hashes: `##hoge`, `###bar`, etc. Up to six hashes (heading depth
 * range), then a *non*-whitespace, *non*-hash character, then the rest
 * of the line. The negative lookahead `(?!\s|#)` blocks two false
 * positives:
 *
 *   - `## hoge`     — already a proper heading (whitespace right after hashes)
 *   - `#######hoge` — 7+ hashes, which CommonMark explicitly excludes
 *                    from heading depth (the 7th `#` would be matched
 *                    here as the "next char" and the lookahead refuses)
 *
 * Anchored to start-of-string because we only run this regex against
 * the very first character of a paragraph's first text child — never
 * mid-line. The trailing `(?:\n|$)` consumes the line terminator so
 * the rest of the paragraph (if any) survives as a follow-up node.
 */
const V1_HEADING_RE = /^(#{1,6})(?!\s|#)([^\n]+?)(?:\n|$)/;

/**
 * `paragraph` → `heading` rewrite for the v1 "no space after hashes"
 * habit. Returns `null` when the paragraph doesn't start with such a
 * v1 heading; returns an array of replacement mdast nodes otherwise
 * (always at least one `heading`, optionally followed by one
 * `paragraph` for the leftover content).
 *
 * Examples (using `||` to show what becomes which output node):
 *
 *   "##hoge"               → heading[depth=2, "hoge"]
 *   "##hoge\nbar"          → heading[depth=2, "hoge"] || paragraph["bar"]
 *   "###foo\n\nbar"        → only the first paragraph is touched
 *                            (mdast already split at `\n\n`); we see
 *                            `paragraph[text("###foo")]` and emit
 *                            `heading[depth=3, "foo"]`.
 *
 * Stops at the first newline by design — multi-line `##hoge\nbaz` is
 * (under v1 semantics) a heading line followed by a body line, so we
 * preserve that intent rather than treating the whole text node as a
 * single heading.
 */
function v1HeadingReplacement(paragraph: Paragraph): Array<Heading | Paragraph> | null {
  const first = paragraph.children[0];
  if (!first || first.type !== 'text') return null;
  const match = V1_HEADING_RE.exec(first.value);
  if (!match) return null;

  const hashes = match[1];
  const headingText = match[2];
  const consumed = match[0].length;
  const restValue = first.value.slice(consumed);

  const heading: Heading = {
    type: 'heading',
    depth: hashes.length as Heading['depth'],
    children: [{ type: 'text', value: headingText }],
  };

  // Rebuild the remainder of the original paragraph. If the regex
  // consumed a trailing `\n` and the next sibling is a `break` (which
  // remark-breaks injects when running before this plugin), drop that
  // leading break — otherwise the follow-up paragraph would start with
  // a spurious `<br>` before its first line of real text.
  const restChildren: PhrasingContent[] = [];
  if (restValue.length > 0) {
    restChildren.push({ type: 'text', value: restValue });
  }
  for (let i = 1; i < paragraph.children.length; i++) {
    const child = paragraph.children[i];
    if (restChildren.length === 0 && child.type === 'break') continue;
    restChildren.push(child);
  }

  if (restChildren.length === 0) return [heading];
  return [heading, { type: 'paragraph', children: restChildren }];
}

/**
 * unified transform plugin: walk the root's top-level children and
 * rewrite v1-style "##heading" paragraphs into real `heading` nodes.
 *
 * Scope is intentionally top-level only. v1's quirk shows up at the
 * top of a page body where users wrote section headers; headings
 * nested inside list items or block quotes are uncommon in legacy
 * Crowi content and we don't want to surprise authors who deliberately
 * write `##` inside a quote block as literal text.
 *
 * Limitation: rewritten headings do *not* appear in the page's TOC
 * and do *not* get slug-derived anchor IDs. The core `headings`
 * transform runs before this plugin (registry transforms always
 * follow the core 4), so by the time we create new heading nodes the
 * TOC is already built. The README documents this — the recommended
 * long-term path is to clean up the source to `## hoge`. We accept
 * the limitation because adding heading-slug computation here would
 * duplicate the core plugin's logic and is overkill for a migration
 * compatibility shim.
 */
export const remarkFixV1Headings = () => (tree: Root) => {
  const next: Root['children'] = [];
  for (const node of tree.children) {
    if (node.type !== 'paragraph') {
      next.push(node);
      continue;
    }
    const replacement = v1HeadingReplacement(node as Paragraph);
    if (replacement) {
      next.push(...replacement);
    } else {
      next.push(node);
    }
  }
  tree.children = next;
};

/**
 * Crowi v1 compatibility quirks aggregator.
 *
 * Phase 5 of RFC-0002 narrowed this plugin's scope: the single-newline
 * → `<br>` behaviour (originally implemented here via remark-breaks)
 * moved into the core pipeline as a Crowi default because it matches
 * GitHub-Flavored Markdown's own rendering — every modern markdown
 * surface users land on (GitHub, GitLab, Slack, etc.) treats single
 * newlines as `<br>`, and CommonMark's pure soft-break behaviour
 * surprises authors more often than it helps.
 *
 * What this plugin still does is fix *actual* v1 idiosyncrasies that
 * are NOT standard markdown:
 *
 *   - `##hoge` (heading hashes without the spec-required space)
 *     → rewrite as a proper `## hoge` heading. v1 accepted this form
 *     because non-engineer authors often skipped the space; CommonMark
 *     treats it as a plain paragraph.
 *
 * Future v1 quirks (H1 → page title, `</path>` angle-bracket internal
 * links, PHP-style includes, etc.) may be added here as individual
 * mdast transforms with their own opt-in config.
 *
 * The plugin is **off by default** in the runner's `crowi.config.json`
 * so fresh v2 installs get strict-modern semantics. Operators
 * migrating from Crowi 1.x add it to `plugins` to keep their pages
 * rendering the way authors expect.
 */
const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-crowi-legacy',
  version: '0.1.0-dev',

  adminPlacement: {
    section: 'renderer',
    label: 'Crowi v1 compatibility',
    icon: 'wand-2',
  },

  registerRenderer: (registry, ctx) => {
    registry.addUnifiedPlugin(remarkFixV1Headings, { phase: 'transform' });
    ctx.log.debug('registered v1-heading-fix on the transform phase (##hoge → ## hoge)');
  },
};

export default plugin;
