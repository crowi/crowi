'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Check, Copy, Link2, X } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import Link from 'next/link';
import { useCopyFeedback } from '@/lib/use-copy-feedback';
import { canonicalizeLegacyAttachmentUrl } from '@/lib/attachment-url';
import {
  getFigureLayoutClassName,
  getImageDisplayStyle,
  hasFigureMarker,
  mergeImageClassName,
  mergeImageStyle,
  stripImageDisplayTransportProps,
} from '@/components/editor/image-display';
import { LI_CLASSNAME, mergeListClassName, OL_CLASSNAME, UL_CLASSNAME } from '@/components/editor/list-classnames';
import { renderMdastToReactNode } from '@/components/editor/render-mdast';
import { MentionLink } from '@/components/page-view/mention-link';
import { extractAttachmentId, InlineAttachmentLink, InlineAttachmentProvider } from '@/components/page-view/inline-attachment-link';
import { MarkdownTableFullscreen } from '@/components/page-view/markdown-table-fullscreen';
import { RendererPresentation, isDiagramPresentationReady, pickRendererPresentationAttrs } from '@/components/page-view/renderer-presentation';

interface PageContentProps {
  page: PageWithRevision;
}

// `section` wrap + `<section>` highlight live in render-mdast.ts +
// `TargetedSection` below. The show page passes `sectionWrap: true`
// because the URL-hash highlight needs a wrappable element above each
// heading. The editor preview keeps the wrap off — it has no URL hash
// to react to and a flatter tree is closer to what the user typed.

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

function HeadingAnchor({ id }: { id?: string }) {
  const { copied, copy } = useCopyFeedback();

  if (!id) return null;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (typeof window === 'undefined') return;
    copy(`${window.location.origin}${window.location.pathname}#${id}`);
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

/**
 * Fenced code block with a GitHub-style hover copy button. The single
 * chokepoint for every code block: shiki-highlighted fences arrive as raw
 * `<pre>` HTML that `raw()` parses back into a `<pre>` element, so they map
 * through this `pre` override too. The copied text is read from the rendered
 * `<pre>`'s `textContent`, which is correct for both shiki span trees and
 * plain (un-highlighted) code.
 */
function CodeBlock({ children, ...props }: ChildrenProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopyFeedback();

  const handleCopy = () => copy(preRef.current?.textContent ?? '');

  return (
    <InsidePreContext.Provider value={true}>
      <div className="group/code relative my-6">
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? m['page.code_copied']() : m['page.code_copy']()}
          title={copied ? m['page.code_copied']() : m['page.code_copy']()}
          className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        </button>
        {/* `min-w-0` lets the parent flex/grid track shrink below the
            <pre>'s natural width, otherwise long lines push the column
            wider than the viewport instead of triggering `overflow-x-auto`. */}
        <pre
          ref={preRef}
          className="bg-muted border border-border/60 rounded-xl px-4 py-3 text-[0.875rem] leading-relaxed font-mono overflow-x-auto max-w-full min-w-0"
          {...props}
        >
          {children}
        </pre>
      </div>
    </InsidePreContext.Provider>
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

// Marks the subtree as being inside a fenced code block's <pre>. The
// `code` override below reads this to decide between inline pill
// styling and "let the surrounding <pre> handle the chrome" styling.
// className alone can't distinguish the two because ``` blocks
// without a language come through with `className === undefined`,
// same as inline backtick code.
const InsidePreContext = createContext(false);

// Components map for hast-util-to-jsx-runtime. Keeps the same Tailwind
// look as the Phase 1/2 ReactMarkdown setup — only the bridge layer
// changed. Note `code` distinguishes inline from block via
// `InsidePreContext` set by the `pre` override; shiki-highlighted
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

/**
 * Resolve a link href to an internal app path, or `null` when it points
 * elsewhere. A bare `/path` is internal as-is; an absolute `http(s)` URL
 * is internal when its origin matches the running app's — covers links
 * written as full URLs (e.g. copied from the address bar). Internal
 * links route through the Next.js router instead of a full document
 * load. Runs client-side only: the page body never appears in SSR
 * output (the show page renders a loading spinner until the react-query
 * fetch resolves), so `window.location.origin` is always available.
 */
function toInternalHref(href: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (typeof window === 'undefined' || !/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.origin !== window.location.origin) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

const components = {
  section: TargetedSection,
  h1: makeHeading('h1'),
  h2: makeHeading('h2'),
  h3: makeHeading('h3'),
  h4: makeHeading('h4'),
  h5: makeHeading('h5'),
  h6: makeHeading('h6'),
  a: ({ href: rawHref, children, className, ...props }: { href?: string; children?: React.ReactNode; className?: string }) => {
    // Canonicalize a persisted legacy `/api/v2/attachments/...` href BEFORE
    // any detection/use below (spec §5.3) — every subsequent branch
    // (attachment link, internal router link, plain external `<a>`) reads
    // the canonical value. A no-op for every other href shape.
    const href = canonicalizeLegacyAttachmentUrl(rawHref);
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
    // Wikilinks / mentions stamp `className` server-side via
    // `data.hProperties.className`; mdast-util-to-hast forwards that
    // straight to the hast `properties.className` and into our props.
    // Broken wikilinks render dimmed without underline; mentions pick
    // up the primary colour with weight bump.
    const isBrokenWikiLink = className === 'wikilink-broken';
    const isMention = className === 'mention';
    // A mention renders as avatar + `@username` with a name tooltip;
    // `MentionLink` hydrates the user from the username in the href.
    if (isMention && href?.startsWith('/user/')) {
      return <MentionLink username={href.slice('/user/'.length)} />;
    }
    const composedClassName = isBrokenWikiLink
      ? 'text-muted-foreground/80 decoration-dotted decoration-muted-foreground/40 underline underline-offset-[3px] cursor-help'
      : isMention
        ? 'text-primary font-medium decoration-primary/40 hover:decoration-primary/70 underline underline-offset-[3px] transition-colors'
        : 'text-primary decoration-primary/30 hover:decoration-primary/70 underline underline-offset-[3px] transition-colors';
    // Attachment references (`/api/attachments/<id>` or legacy
    // `/files/<id>`) open the detail modal on left-click instead of
    // full-page-navigating to the raw file — see `InlineAttachmentLink`.
    const attachmentId = extractAttachmentId(href);
    if (attachmentId && href) {
      return (
        <InlineAttachmentLink attachmentId={attachmentId} variant="link" href={href} className={composedClassName}>
          {children}
        </InlineAttachmentLink>
      );
    }
    // Internal links (bare `/path` wikilinks/page links, or full URLs
    // pointing at this same app) navigate through the Next.js router —
    // a client-side transition, no full document reload, no auth
    // re-check, no layout loading flash. Genuinely external links and
    // in-page `#` anchors (incl. broken wikilinks, whose href is `#`)
    // stay plain `<a>`.
    const internalHref = toInternalHref(href);
    if (internalHref) {
      return (
        <Link href={internalHref} className={composedClassName} {...props}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} className={composedClassName} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noopener noreferrer' : undefined} {...props}>
        {children}
      </a>
    );
  },
  // Inline vs block code is decided by `InsidePreContext` set by the
  // `pre` override below. className alone is unreliable: a ``` block
  // without a language tag reaches us with `className === undefined`,
  // same as inline backtick code, so a className-only check
  // mis-classified those as inline and applied the pill chrome inside
  // the <pre>. Shiki-highlighted fences arrive as raw HTML and never
  // hit this component at all.
  code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
    // The lowercase `code` is the components-map key handed to
    // hast-util-to-jsx-runtime — it renders this as a React component,
    // so `useContext` is a legitimate hook call here.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const isBlock = useContext(InsidePreContext);
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    // GitHub-style inline code pill: muted background + rounded
    // corners + a touch of horizontal padding so backtick spans pop
    // out of the surrounding prose. `before/after:content-none`
    // strips the default `&grave;…&grave;` decorators some prose
    // themes inject around the pill.
    return (
      <code className="bg-muted text-foreground font-mono text-[0.85em] rounded-md px-1.5 py-0.5 before:content-none after:content-none" {...props}>
        {children}
      </code>
    );
  },
  pre: CodeBlock,
  blockquote: ({ children, ...props }: ChildrenProps) => (
    <blockquote className="border-l-2 border-foreground/25 pl-4 my-6 text-foreground/75 [&>p]:my-2" {...props}>
      {children}
    </blockquote>
  ),
  // Page-view-only fullscreen affordance — see `markdown-table-fullscreen.tsx`.
  // The editor preview's `table` override (`MarkdownPreview.tsx`) stays the
  // plain `overflow-x-auto` wrapper this used to be; only the reading
  // surface gets the expand-to-Dialog chrome.
  table: MarkdownTableFullscreen,
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
  // `className` is destructured out and merged (not spread) so the
  // GFM `contains-task-list` / `task-list-item` markers reach the
  // Tailwind `[&.…]` variants instead of clobbering the base classes.
  ul: ({ children, className, ...props }: ChildrenProps & { className?: unknown }) => (
    <ul className={mergeListClassName(UL_CLASSNAME, className)} {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, className, ...props }: ChildrenProps & { className?: unknown }) => (
    <ol className={mergeListClassName(OL_CLASSNAME, className)} {...props}>
      {children}
    </ol>
  ),
  li: ({ children, className, ...props }: ChildrenProps & { className?: unknown }) => (
    <li className={mergeListClassName(LI_CLASSNAME, className)} {...props}>
      {children}
    </li>
  ),
  // GFM task-list checkboxes (`- [ ]` / `- [x]`) arrive as
  // `<input type="checkbox" checked disabled>`. React warns
  // ("changing an uncontrolled input to be controlled") when `checked`
  // is passed without `onChange` / `readOnly`; force a controlled,
  // non-interactive checkbox. Any other `<input>` passes through.
  input: ({ type, checked, ...props }: { type?: string; checked?: unknown; [key: string]: unknown }) =>
    type === 'checkbox' ? <input type="checkbox" checked={Boolean(checked)} readOnly {...props} /> : <input type={type} {...props} />,
  img: ({
    src,
    alt,
    className,
    style: rawStyle,
    ...rest
  }: {
    src?: string | Blob;
    alt?: string;
    className?: unknown;
    style?: React.CSSProperties;
    [key: string]: unknown;
  }) => {
    const rawSrcString = typeof src === 'string' ? src : undefined;
    // Canonicalize a persisted legacy `/api/v2/attachments/...` src BEFORE
    // the by-key-aware `extractAttachmentId()` detection below (spec §5.3):
    // a by-key src (`/api/v2/attachments/by-key/user%2F<id>.<ext>`) never
    // matches the 24-hex-id detection regex, so detecting first would leave
    // it un-canonicalized in the plain `<img>` fallback branch and 404.
    // Canonicalizing first fixes both the `InlineAttachmentLink` branch and
    // the fallback branch with the same call.
    const srcString = canonicalizeLegacyAttachmentUrl(rawSrcString);
    // Server-rendered "ready diagram" presentation — an optional renderer
    // plugin's PNG-fallback or `<img>`-success output (core reads only the
    // generic `data-crowi-renderer-presentation="diagram"`/`data-crowi-
    // renderer-state="ready"` contract, plus the legacy
    // `.diagram-embed`/`*-error` dual-accept for already-persisted
    // `renderedAst` — see `isDiagramPresentationReady`). Route it through
    // the same cap-to-width + click-to-enlarge wrapper; the wrapper carries the
    // real incoming `className` + data attributes (so both the legacy
    // `.diagram-embed` CSS and the new `[data-crowi-renderer-…]` selector
    // apply) while the inner <img> only needs the responsive sizing
    // utilities.
    if (isDiagramPresentationReady(className, rest)) {
      // A renderer plugin (e.g. Mermaid) may embed intrinsic `width`/
      // `height` on the source `<img>` — its own SVG payload can declare
      // a percentage width with no absolute height, which otherwise
      // leaves the browser nothing to size the element by inside this
      // `inline-block` wrapper (whose own width is itself `auto`, sized
      // from its content): the two collapse to 0×0. Forward them
      // (never dropped by the destructure above — they land in `rest`)
      // so `h-auto` has an aspect ratio to scale from; a renderer that
      // doesn't declare them leaves the element exactly as before.
      const width = typeof rest.width === 'string' || typeof rest.width === 'number' ? rest.width : undefined;
      const height = typeof rest.height === 'string' || typeof rest.height === 'number' ? rest.height : undefined;
      return (
        <RendererPresentation className={typeof className === 'string' ? className : undefined} presentationAttrs={pickRendererPresentationAttrs(rest)}>
          {/* biome-ignore lint/performance/noImgElement: rich-text rendered as plain markdown */}
          <img src={srcString} alt={alt || ''} className="max-w-full h-auto" loading="lazy" width={width} height={height} />
        </RendererPresentation>
      );
    }
    // RFC-0015 image display attributes — img layer (width/height
    // only; align/float are figure-only, see the `figure` override
    // below). `getImageDisplayStyle` re-validates by VALUE regardless
    // of whether the `data-crowi-image-*` came from the transform or
    // was forged via raw HTML (§D4/§D5 — this is the trust boundary).
    // An unrelated raw `<img>`'s own `class`/`style` (and any other
    // prop) are NOT touched by this feature — MERGED, never replaced
    // (AC-B3): `mergeImageClassName` folds the incoming `className`
    // into the base utility classes, `mergeImageStyle` folds the
    // incoming `style` under the re-validated display style.
    const imgClassName = mergeImageClassName('max-w-full h-auto rounded-lg my-6', className);
    const displayStyle = getImageDisplayStyle(rest);
    const mergedStyle = mergeImageStyle(rawStyle, displayStyle);
    const restProps = stripImageDisplayTransportProps(rest);
    // An embedded attachment image still renders the image, but a plain
    // left-click opens the detail modal instead of navigating to the raw
    // file. Right-click (save / copy) and modifier-clicks are untouched.
    // `restProps` is deliberately NOT forwarded here (unlike the plain
    // `<img>` branch below): `InlineAttachmentLink`'s image variant only
    // ever accepts the re-validated width/height style (§D11 merge
    // contract) — arbitrary raw-HTML/Markdown props have no defined
    // meaning on this wrapper and are intentionally out of scope.
    const attachmentId = extractAttachmentId(srcString);
    if (attachmentId && srcString) {
      return <InlineAttachmentLink attachmentId={attachmentId} variant="image" href={srcString} className={imgClassName} alt={alt} style={displayStyle} />;
    }
    return (
      // biome-ignore lint/performance/noImgElement: rich-text rendered as plain markdown
      <img src={srcString} alt={alt || ''} className={imgClassName} loading="lazy" style={mergedStyle} {...restProps} />
    );
  },
  // RFC-0015 image display attributes — synthesized standalone-image
  // wrapper. `crowi-figure` is a STYLING marker, not a trust boundary
  // (`hasFigureMarker`'s doc comment): a marker-less raw `<figure>`
  // passes through ORDINARILY (every prop, including `style`,
  // untouched — same passthrough spirit as `div`'s override below),
  // while a marker-bearing one (genuine or raw-HTML-forged —
  // indistinguishable, `passNode: false` gives no node context) only
  // ever receives ONE fixed, re-derived safe layout class. The
  // incoming `style` is dropped ONLY on the marker-bearing branch
  // (forged-marker-safe, RFC §D6/AC-B4).
  figure: ({ className, children, ...props }: ChildrenProps & { className?: unknown }) => {
    if (!hasFigureMarker(className)) {
      return (
        <figure className={typeof className === 'string' ? className : undefined} {...props}>
          {children}
        </figure>
      );
    }
    // Marker-bearing branch only: drop any incoming `style` (raw or
    // forged) before deriving the safe, re-validated layout class —
    // `props`'s declared type has no `style` field (same convention as
    // the `img` override above), so strip it via a cast instead of
    // destructuring a field TypeScript doesn't know about.
    const restRaw = { ...(props as Record<string, unknown>) };
    delete restRaw.style;
    const layoutClass = getFigureLayoutClassName(restRaw);
    const restProps = stripImageDisplayTransportProps(restRaw);
    return (
      <figure className={layoutClass ? `crowi-figure ${layoutClass}` : 'crowi-figure'} {...restProps}>
        {children}
      </figure>
    );
  },
  // Server-rendered "ready diagram" presentation whose root is a `<div>` —
  // an optional renderer plugin's inline-SVG success output (raw HTML
  // parsed by `raw()`). A renderer whose success output is always an
  // `<img>` instead is handled above; an error placeholder can also be a
  // `<div>`, but `isDiagramPresentationReady` excludes it here
  // (state="error" / legacy no-`diagram-embed`-marker) so it renders as a
  // plain div instead. Every other raw-HTML <div> in a body renders
  // plainly.
  div: ({ className, children, ...props }: ChildrenProps & { className?: unknown }) => {
    if (isDiagramPresentationReady(className, props)) {
      return (
        <RendererPresentation className={typeof className === 'string' ? className : undefined} presentationAttrs={pickRendererPresentationAttrs(props)}>
          {children}
        </RendererPresentation>
      );
    }
    return (
      <div className={typeof className === 'string' ? className : undefined} {...props}>
        {children}
      </div>
    );
  },
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

  // Build the rendered React tree from the server-side AST. The
  // mdast → hast → raw → jsxRuntime pipeline now lives in the shared
  // `renderMdastToReactNode` helper so the editor preview pane and
  // this show path stay byte-identical for the same input.
  //
  // Memoized on `revisionId`, not `renderedAst`: react-query refetches
  // (window focus, polling) hand back fresh-identity-but-same-content
  // AST objects, and we don't want to redo the conversion on each one.
  // A new revision means a new `_id`.
  const renderedNode = useMemo(() => {
    return renderMdastToReactNode(renderedAst, {
      sectionWrap: true,
      // The library's component map is typed against its bundled
      // hast types; our component prop signatures are React-typed,
      // so we cast at the boundary.
      components: components as unknown as Parameters<typeof renderMdastToReactNode>[1]['components'],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionId]);

  // Initial scroll. The browser's native anchor jump fires before
  // React commits, so the heading isn't there yet. Watch the document
  // with a MutationObserver until it appears, then scroll — and keep
  // re-scrolling on every subsequent mutation, because later page
  // content (async-loaded comments / attachments, images resolving
  // their intrinsic size) reflows the document and pushes the target
  // heading out of view if we only scrolled once. The observer stops
  // as soon as the user interacts with the page (so we don't fight
  // their own scroll) and otherwise self-disarms after 5s.
  useEffect(() => {
    if (typeof window === 'undefined' || !targetHash) return;

    let observer: MutationObserver | null = null;
    let settleTimeout: number | null = null;
    let safetyTimeout: number | null = null;
    let disposed = false;
    // Track the heading's absolute Y to skip redundant `scrollIntoView`
    // calls. `html { scroll-behavior: smooth }` (Tailwind's
    // `scroll-smooth`) silently converts every scroll request into a
    // smooth animation, and re-issuing on every mutation cancels the
    // in-flight animation and restarts it from 0 — leaving the
    // viewport pinned near the top on pages with chatty mutation
    // streams. Only re-issue when the target *actually* moved.
    let lastTargetTop = Number.NaN;

    const tryScroll = () => {
      if (disposed) return false;
      const target = document.getElementById(targetHash);
      if (!target) return false;
      const top = Math.round(target.getBoundingClientRect().top + window.scrollY);
      if (top === lastTargetTop) return true;
      lastTargetTop = top;
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
      return true;
    };

    const stop = () => {
      disposed = true;
      observer?.disconnect();
      observer = null;
      if (settleTimeout !== null) window.clearTimeout(settleTimeout);
      settleTimeout = null;
      if (safetyTimeout !== null) window.clearTimeout(safetyTimeout);
      safetyTimeout = null;
    };

    // Refresh the settle timer on every mutation. 500ms of quiet ⇒ the
    // page has stopped reflowing and we no longer need to track it.
    // We intentionally do NOT listen for wheel / touch / keydown — the
    // browser already cancels an in-flight smooth scroll when the user
    // scrolls, and external listeners (a) misfire on Trackpad inertia
    // events that fire as part of the click itself, killing our scroll
    // before it ever starts, and (b) add no behaviour the browser
    // doesn't already provide for free.
    const scheduleSettle = () => {
      if (settleTimeout !== null) window.clearTimeout(settleTimeout);
      settleTimeout = window.setTimeout(stop, 500);
    };

    tryScroll();
    scheduleSettle();

    observer = new MutationObserver(() => {
      tryScroll();
      scheduleSettle();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    safetyTimeout = window.setTimeout(stop, 5000);

    return stop;
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
      <InlineAttachmentProvider>
        {/* `key={revisionId}` forces a full remount of this subtree on a new
            revision. `hast-util-to-jsx-runtime` assigns each `<table>` a
            POSITIONAL key (`table-0`, `table-1`, …), so without this key a
            re-render that reorders/inserts tables could fiber-swap a table
            still `open` in `MarkdownTableFullscreen` onto a DIFFERENT
            logical table's props/children — a content-correctness bug, not
            just a lost UI state. The whole-container key sidesteps that by
            never letting React attempt positional reconciliation across a
            revision boundary: every open table Dialog (and any other local
            UI state under here) is discarded instead. */}
        <div className="crowi-prose min-w-0" key={revisionId}>
          {renderedNode}
        </div>
      </InlineAttachmentProvider>
    </TargetHashContext.Provider>
  );
}
