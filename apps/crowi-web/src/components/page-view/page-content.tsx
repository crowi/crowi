'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import { raw } from 'hast-util-raw';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Nodes as HastNodes } from 'hast';
import { Check, Link2, X } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface PageContentProps {
  page: PageWithRevision;
}

// Inline hast subset for the section-wrap pass we still run on the
// client (URL-fragment highlight is a pure UI concern; see
// architecturalNotes / history). Same shape as before — a small
// element walker without bringing in @types/hast.
type HastLike = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
  value?: string;
};

// Wrap each heading + its following sibling content in `<section
// data-section-id="…">`. The heading keeps its `id` so anchor jumps
// land on the heading; the section exists so we can highlight the
// whole block when its heading is the URL fragment target.
//
// RFC-0002 Phase 3 implementer note: the server-side renderer pipeline
// produces mdast, not hast; mdast has no `section` node. Three options
// were on the table — emit `<section>` start/end as adjacent `html`
// nodes, persist hast instead of mdast, or keep this small wrap on
// the web side. We picked the third: it keeps the persisted shape
// simple, the wrap is a UI concern (URL hash highlight) that doesn't
// need to round-trip through the database, and it's a 25-line walk
// that costs essentially nothing on render.
const HEADING_RE = /^h[1-6]$/;
function wrapSections(tree: HastLike): void {
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

// Context delivers the URL fragment target (decoded, no leading `#`)
// to the section component so it can render `className="is-target"`
// reactively. `clear` strips the hash from the URL + state without
// scrolling, used by the X dismiss button in the highlighted section.
interface TargetHashContextValue {
  hash: string;
  clear: () => void;
}
const TargetHashContext = createContext<TargetHashContextValue>({ hash: '', clear: () => {} });

interface TargetedSectionProps extends React.HTMLAttributes<HTMLElement> {
  // hast-util-to-jsx-runtime delivers data-* attributes via this prop
  // bag in camelCase; some library versions also pass them as
  // hyphenated keys. We read both to stay defensive.
  'data-section-id'?: string;
  dataSectionId?: string;
}

function TargetedSection({ children, ...rest }: TargetedSectionProps) {
  const { hash: targetHash, clear } = useContext(TargetHashContext);
  const restRecord = rest as unknown as Record<string, string | undefined>;
  const sectionId: string | undefined = restRecord['data-section-id'] ?? restRecord.dataSectionId;
  const isTarget = !!sectionId && !!targetHash && sectionId === targetHash;
  return (
    <section {...rest} className={isTarget ? 'is-target relative group/section' : undefined}>
      {isTarget && (
        // `z-10` lifts the dismiss button above the heading, which
        // otherwise (as a positioned sibling later in DOM order)
        // captures the pointer over the right-edge area where this
        // button lives.
        <button
          type="button"
          onClick={clear}
          aria-label={m['page.dismiss_highlight']()}
          title={m['page.dismiss_highlight']()}
          className="absolute top-2 right-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/section:opacity-100 hover:text-foreground hover:bg-foreground/10 transition-opacity"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {children}
    </section>
  );
}

const COPY_FEEDBACK_MS = 1500;

function HeadingAnchor({ id }: { id?: string }) {
  const [copied, setCopied] = useState(false);

  if (!id) return null;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
      })
      .catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={copied ? 'Link copied' : 'Copy link to this section'}
      className="absolute -left-7 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground opacity-0 group-hover/heading:opacity-100 hover:text-foreground hover:bg-muted transition-opacity"
    >
      {copied ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}

// Subscribe to URL hash changes via `useSyncExternalStore`. Both
// browser-initiated (back/forward, TOC clicks, anchor copy) and our
// own `clearTarget` (which fires a synthetic event after replaceState)
// route through the `hashchange` listener — keeps the URL the single
// source of truth and dodges React 19's `set-state-in-effect` rule
// that flagged the Phase 2 useState + useEffect bridge.
const HASH_CHANGE_EVENT = 'hashchange';
const subscribeHash = (cb: () => void) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(HASH_CHANGE_EVENT, cb);
  return () => window.removeEventListener(HASH_CHANGE_EVENT, cb);
};
// SSR snapshot is empty string; client snapshot reads the live hash.
// Both must be stable string values (not new objects) so React's
// shallow compare doesn't loop.
const getHashSnapshot = () => (typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1)));
const getHashServerSnapshot = () => '';

// Components map for hast-util-to-jsx-runtime. Keeps the same Tailwind
// look as the Phase 1/2 ReactMarkdown setup — only the bridge layer
// changed. Note `code` distinguishes inline (no `className`) from
// fenced fallback (has `className="language-x"`); shiki-highlighted
// blocks come through as raw `<pre>` HTML and skip this map entirely.
type ChildrenProps = { children?: React.ReactNode };

const HEADING_BASE = {
  h1: 'group/heading relative text-3xl font-bold tracking-tight mt-12 mb-4 first:mt-0 leading-tight scroll-mt-24',
  h2: 'group/heading relative text-2xl font-semibold tracking-tight mt-10 mb-3 first:mt-0 leading-snug scroll-mt-24',
  h3: 'group/heading relative text-xl font-semibold mt-8 mb-2 first:mt-0 leading-snug scroll-mt-24',
  h4: 'group/heading relative text-lg font-semibold mt-6 mb-2 first:mt-0 scroll-mt-24',
  h5: 'group/heading relative text-base font-semibold mt-5 mb-2 first:mt-0 scroll-mt-24',
  h6: 'group/heading relative text-sm font-semibold uppercase tracking-wide mt-5 mb-2 first:mt-0 scroll-mt-24',
} as const;

type HeadingTag = keyof typeof HEADING_BASE;

function makeHeading(Tag: HeadingTag) {
  const Heading = ({ children, id, ...props }: ChildrenProps & { id?: string }) => (
    <Tag id={id} className={HEADING_BASE[Tag]} {...props}>
      <HeadingAnchor id={id} />
      {children}
    </Tag>
  );
  Heading.displayName = `Heading(${Tag})`;
  return Heading;
}

const components = {
  section: TargetedSection,
  h1: makeHeading('h1'),
  h2: makeHeading('h2'),
  h3: makeHeading('h3'),
  h4: makeHeading('h4'),
  h5: makeHeading('h5'),
  h6: makeHeading('h6'),
  a: ({ href, children, className, ...props }: { href?: string; children?: React.ReactNode; className?: string }) => {
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
    // Wikilinks / mentions stamp `className` server-side via
    // `data.hProperties.className`; mdast-util-to-hast forwards that
    // straight to the hast `properties.className` and into our props.
    // Broken wikilinks render dimmed without underline; mentions pick
    // up the primary colour with weight bump.
    const isBrokenWikiLink = className === 'wikilink-broken';
    const isMention = className === 'mention';
    const composedClassName = isBrokenWikiLink
      ? 'text-muted-foreground/80 decoration-dotted decoration-muted-foreground/40 underline underline-offset-[3px] cursor-help'
      : isMention
        ? 'text-primary font-medium decoration-primary/40 hover:decoration-primary/70 underline underline-offset-[3px] transition-colors'
        : 'text-primary decoration-primary/30 hover:decoration-primary/70 underline underline-offset-[3px] transition-colors';
    return (
      <a href={href} className={composedClassName} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noopener noreferrer' : undefined} {...props}>
        {children}
      </a>
    );
  },
  // Inline code: no `className` (markdown's `inlineCode` node turns
  // into a `<code>` without language). Fenced code WITHOUT a known
  // language reaches us with `className="language-x"`; shiki-highlighted
  // fences arrive as raw HTML and never hit this component.
  code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
    const isInline = !className;
    if (isInline) {
      // Background-less inline code: font + foreground color do the
      // identifying work, no muted pill. The `before/after:content-none`
      // strips the default `&grave;…&grave;` decorators some prose
      // themes inject.
      return (
        <code className="text-foreground font-mono text-[0.95em] before:content-none after:content-none" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: ChildrenProps) => (
    <pre className="bg-muted/60 border border-border/60 rounded-xl px-4 py-3 my-6 text-[0.875rem] leading-relaxed font-mono overflow-x-auto" {...props}>
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }: ChildrenProps) => (
    <blockquote className="border-l-2 border-foreground/25 pl-4 my-6 text-foreground/75 [&>p]:my-2" {...props}>
      {children}
    </blockquote>
  ),
  table: ({ children, ...props }: ChildrenProps) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }: ChildrenProps) => (
    <thead className="border-b border-foreground/15" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }: ChildrenProps) => (
    <tbody className="[&>tr]:border-b [&>tr]:border-foreground/10 [&>tr:last-child]:border-0" {...props}>
      {children}
    </tbody>
  ),
  th: ({ children, ...props }: ChildrenProps) => (
    <th className="px-3 py-2 text-left font-semibold text-foreground/80 align-top" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: ChildrenProps) => (
    <td className="px-3 py-2 align-top" {...props}>
      {children}
    </td>
  ),
  ul: ({ children, ...props }: ChildrenProps) => (
    <ul className="list-disc pl-6 my-4 space-y-1.5 marker:text-foreground/40" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: ChildrenProps) => (
    <ol className="list-decimal pl-6 my-4 space-y-1.5 marker:text-foreground/40" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: ChildrenProps) => (
    <li className="leading-relaxed [&>p]:my-1" {...props}>
      {children}
    </li>
  ),
  img: ({ src, alt, ...props }: { src?: string | Blob; alt?: string }) => (
    // biome-ignore lint/performance/noImgElement: rich-text rendered as plain markdown
    <img src={typeof src === 'string' ? src : undefined} alt={alt || ''} className="max-w-full h-auto rounded-lg my-6" loading="lazy" {...props} />
  ),
  hr: ({ ...props }) => <hr className="my-10 border-foreground/10" {...props} />,
  p: ({ children, ...props }: ChildrenProps) => (
    <p className="my-4 leading-[1.7] text-foreground/90" {...props}>
      {children}
    </p>
  ),
  strong: ({ children, ...props }: ChildrenProps) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
};

export function PageContent({ page }: PageContentProps) {
  const body = page.revision?.body || '';
  const renderedAst = page.revision?.renderedAst;
  const revisionId = page.revision?._id;

  // URL hash is the single source of truth; `useSyncExternalStore`
  // re-renders on every `hashchange` (TOC click, anchor copy, browser
  // back/forward, or our synthetic dispatch from `clearTarget`).
  const targetHash = useSyncExternalStore(subscribeHash, getHashSnapshot, getHashServerSnapshot);

  // Strip the hash without scrolling. `replaceState` skips the native
  // `hashchange` event, so we dispatch one ourselves to nudge
  // useSyncExternalStore subscribers.
  const clearTarget = useCallback(() => {
    if (typeof window === 'undefined') return;
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    window.dispatchEvent(new HashChangeEvent(HASH_CHANGE_EVENT));
  }, []);

  const targetHashContextValue = useMemo<TargetHashContextValue>(() => ({ hash: targetHash, clear: clearTarget }), [targetHash, clearTarget]);

  // Build the rendered React tree from the server-side AST. mdast →
  // hast → jsx is the same path react-markdown ran internally; doing
  // it directly drops the duplicate parse + plugin chain on the client.
  // `allowDangerousHtml: true` is required so shiki-highlighted code
  // blocks (persisted as `html` nodes carrying `<pre class="shiki">…`)
  // and any future embed plugins flow through to the React tree as
  // `dangerouslySetInnerHTML` instead of being escaped.
  //
  // Memoized on `revisionId`, not `renderedAst`: react-query refetches
  // (window focus, polling) hand back fresh-identity-but-same-content
  // AST objects, and we don't want to redo `toHast` + `wrapSections` +
  // `toJsxRuntime` on each one. A new revision means a new `_id`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const renderedNode = useMemo(() => {
    if (!renderedAst) return null;
    const hast = toHast(renderedAst as Parameters<typeof toHast>[0], { allowDangerousHtml: true });
    if (!hast) return null;
    // Section wrap (URL-hash highlight) runs BEFORE `raw()` so its
    // walker only sees the shallow mdast-derived top-level tree —
    // raw expansion of shiki output would otherwise inflate the
    // walked node count by the size of every highlighted block.
    // `<pre>` arrives here as a `raw` hast node; wrapSections groups
    // it into the surrounding `<section>` either way.
    wrapSections(hast as HastLike);
    // `mdast-util-to-hast` with `allowDangerousHtml: true` converts
    // `html` mdast nodes into `raw` hast nodes (a marker, not an
    // element). `hast-util-to-jsx-runtime` ignores `raw` nodes, so
    // shiki-rendered `<pre class="shiki ...">` html nodes would
    // disappear entirely. `hast-util-raw` parses the raw HTML string
    // into real hast elements that the JSX runtime can render.
    const parsed = raw(hast as HastNodes);
    return toJsxRuntime(parsed, {
      Fragment,
      jsx,
      jsxs,
      // The library's component map is typed against its bundled
      // hast types; our component prop signatures are React-typed,
      // so we cast at the boundary.
      components: components as unknown as Parameters<typeof toJsxRuntime>[1]['components'],
      // `passNode: false` — otherwise every component receives a
      // `node` prop which React stringifies onto the DOM as
      // `node="[object Object]"`. `data-*` attributes are still
      // forwarded normally via the rest props bag, so
      // `TargetedSection` can keep reading `data-section-id` without
      // the hast node escape hatch.
      passNode: false,
    });
  }, [revisionId]);

  // Initial scroll. The browser's native anchor jump fires before
  // React commits, so the heading isn't there yet. Watch the document
  // with a MutationObserver until it appears, then scroll. Bound by a
  // 5s safety timeout.
  useEffect(() => {
    if (typeof window === 'undefined' || !targetHash) return;

    const tryScroll = () => {
      const target = document.getElementById(targetHash);
      if (!target) return false;
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
      return true;
    };

    if (tryScroll()) return;

    let observer: MutationObserver | null = new MutationObserver(() => {
      if (tryScroll()) {
        observer?.disconnect();
        observer = null;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeoutId = window.setTimeout(() => {
      observer?.disconnect();
      observer = null;
    }, 5000);

    return () => {
      observer?.disconnect();
      window.clearTimeout(timeoutId);
    };
  }, [body, targetHash]);

  if (!body) {
    return <div className="text-muted-foreground text-center py-8">This page has no content.</div>;
  }

  // Body present but AST missing — only happens transiently if the on-
  // the-fly fallback failed. Render nothing rather than crashing; the
  // surrounding page chrome (path, author, edit button) keeps working.
  if (!renderedNode) {
    return <div className="text-muted-foreground text-center py-8">Rendering…</div>;
  }

  return (
    <TargetHashContext.Provider value={targetHashContextValue}>
      <div className="crowi-prose">{renderedNode}</div>
    </TargetHashContext.Provider>
  );
}
