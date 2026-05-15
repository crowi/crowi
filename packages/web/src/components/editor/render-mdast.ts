'use client';

import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import { raw } from 'hast-util-raw';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Nodes as HastNodes } from 'hast';
import type { ReactNode } from 'react';

/**
 * Minimal hast subset used by `wrapSections`. Keeping this local
 * avoids pulling `@types/hast` into the editor surface (already
 * a dep of `page-content.tsx` but the shape is small enough that
 * duplication is cheaper than another type-export plumbing pass).
 */
export type HastLike = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
  value?: string;
};

const HEADING_RE = /^h[1-6]$/;

/**
 * Group each heading + its following sibling content into a
 * `<section data-section-id="…">` so the URL-fragment highlight on the
 * show page has a wrappable element. Pure walk; mutates in place
 * (caller passes a fresh hast tree from `toHast`).
 *
 * Lifted out of `page-content.tsx` so the editor preview can run the
 * same wrap when `sectionWrap: true`. The preview path keeps it off
 * (no anchor jump or hover affordances exist in the preview pane).
 */
export function wrapSections(tree: HastLike): void {
  if (!tree.children) return;
  const out: HastLike[] = [];
  let current: HastLike | null = null;

  for (const child of tree.children) {
    const isHeading = child.type === 'element' && typeof child.tagName === 'string' && HEADING_RE.test(child.tagName);
    if (isHeading) {
      const id = (child.properties?.id as string | undefined) ?? undefined;
      current = {
        type: 'element',
        tagName: 'section',
        properties: id ? { 'data-section-id': id } : {},
        children: [child],
      };
      out.push(current);
    } else if (current) {
      current.children!.push(child);
    } else {
      out.push(child);
    }
  }

  tree.children = out;
}

export interface RenderMdastOptions {
  /**
   * Toggle the `wrapSections` pass + `<section>` component override.
   * The show page (`page-content.tsx`) wants the wrap so its URL hash
   * highlight can climb to the section element; the editor preview
   * never reads the URL hash, so it leaves the tree unwrapped to keep
   * the produced React tree closer to plain mdast.
   */
  sectionWrap?: boolean;
  /**
   * Components map passed to `toJsxRuntime`. Both the show page and
   * the preview want the same prose-styling overrides (h1..h6, table,
   * code, blockquote, etc.). The show page additionally injects a
   * `section` override (URL-hash highlight); the preview omits it.
   */
  components: Parameters<typeof toJsxRuntime>[1]['components'];
}

/**
 * Convert a server-emitted mdast tree to a React node, running the
 * same `toHast → raw → toJsxRuntime` pipeline the show page uses.
 *
 * Why share this with the preview: the show page's renderer is the
 * single source of truth for "what this body looks like". Duplicating
 * the conversion on the preview side risks drift (e.g. different
 * shiki escape behaviour for HTML fences). Going through one helper
 * means edit preview and page show are byte-identical for the same
 * input.
 *
 * `allowDangerousHtml: true` is required because shiki-highlighted
 * fences arrive as `html` mdast nodes carrying `<pre class="shiki">…`
 * markup; `mdast-util-to-hast` turns them into `raw` hast nodes which
 * `hast-util-to-jsx-runtime` ignores unless we let `hast-util-raw`
 * parse them into real elements first.
 */
export function renderMdastToReactNode(renderedAst: unknown, options: RenderMdastOptions): ReactNode {
  if (!renderedAst) return null;
  const hast = toHast(renderedAst as Parameters<typeof toHast>[0], { allowDangerousHtml: true });
  if (!hast) return null;
  if (options.sectionWrap) {
    // Section wrap MUST run before `raw()` so the walker only sees the
    // shallow mdast-derived top-level tree — `raw` expands shiki output
    // into hundreds of nodes per highlighted block and walking those
    // is wasted work.
    wrapSections(hast as HastLike);
  }
  const parsed = raw(hast as HastNodes);
  return toJsxRuntime(parsed, {
    Fragment,
    jsx,
    jsxs,
    components: options.components,
    // `passNode: false` — otherwise every component receives a `node`
    // prop that React stringifies onto the DOM. data-* attrs still
    // flow through via the rest props bag.
    passNode: false,
  });
}
