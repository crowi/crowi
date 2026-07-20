'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePreview } from '@/lib/use-preview';
import {
  getFigureLayoutClassName,
  getImageDisplayStyle,
  hasFigureMarker,
  mergeImageClassName,
  mergeImageStyle,
  stripImageDisplayTransportProps,
} from './image-display';
import { LI_CLASSNAME, mergeListClassName, OL_CLASSNAME, UL_CLASSNAME } from './list-classnames';
import { renderMdastToReactNode } from './render-mdast';
import { DiagramEmbed, isDiagramEmbed } from '@/components/page-view/diagram-embed';
import { m } from '@paraglide/messages.js';
import { replaceLinkCardPreviewPlaceholders } from './link-card-preview-placeholder';

const DEBOUNCE_MS = 250;

interface MarkdownPreviewProps {
  source: string;
  className?: string;
  /**
   * When `false`, the debounced preview fetch is suppressed. Pass
   * `false` for the inactive tab on narrow viewports so the hidden
   * pane doesn't cost a server roundtrip per keystroke. Defaults to
   * `true` (wide / always-visible case).
   */
  active?: boolean;
}

function isExternalHref(href: string | undefined): boolean {
  return href?.startsWith('http://') === true || href?.startsWith('https://') === true;
}

/**
 * Live preview pane fed by the same renderer pipeline as the show
 * page — `POST /api/v2/pages/preview` returns mdast that we run
 * through `renderMdastToReactNode` with `sectionWrap: false` (no URL
 * hash / no copy-link affordance for preview).
 *
 * Debounce: 250ms via `useEffect` + `setTimeout`. We trigger the
 * mutation after the timer fires; the cleanup function cancels the
 * pending timer if `source` changes before it fires, so a fast typist
 * only triggers one request per pause instead of one per keystroke.
 * The 250ms threshold is the same one the legacy v1 editor used.
 *
 * Render strategy: store the latest successful `renderedAst` in
 * component state so we keep showing the previous preview while a
 * new request is in flight. Otherwise the pane would flash empty
 * between keystrokes.
 */
export function MarkdownPreview({ source, className, active = true }: MarkdownPreviewProps) {
  const previewMutation = usePreview();
  const [renderedAst, setRenderedAst] = useState<unknown>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    // Inactive tab: skip the fetch entirely. Hidden panes still keep
    // their last AST so they're ready when the user switches back.
    if (!active) return;

    // Empty body short-circuits: no need to hit the server for the
    // empty AST, and the "Preview" placeholder below covers it.
    if (source === '') {
      setRenderedAst(null);
      setErrored(false);
      return;
    }

    // Stale-response guard: if `source` changes (or the effect tears
    // down) while a mutation is in flight, the late `.then` must not
    // overwrite the newer state. The cleanup flips `stale` so the
    // late callback bails out.
    let stale = false;
    const id = window.setTimeout(() => {
      previewMutation
        .mutateAsync(source)
        .then((ast) => {
          if (stale) return;
          setRenderedAst(ast);
          setErrored(false);
        })
        .catch(() => {
          if (stale) return;
          setErrored(true);
        });
    }, DEBOUNCE_MS);

    return () => {
      stale = true;
      window.clearTimeout(id);
    };
    // `previewMutation` identity changes per render; depending on it
    // would defeat the debounce. We intentionally only watch `source`
    // and `active`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, active]);

  const renderedNode: ReactNode = useMemo(() => {
    return renderMdastToReactNode(replaceLinkCardPreviewPlaceholders(renderedAst, m['edit.link_card_preview_pending']()), {
      sectionWrap: false,
      components: previewComponents as unknown as Parameters<typeof renderMdastToReactNode>[1]['components'],
    });
  }, [renderedAst]);

  if (source === '') {
    return <div className={className ?? 'text-muted-foreground'}>{m['edit.preview_placeholder']()}</div>;
  }

  if (errored) {
    return <div className={className ?? 'text-destructive text-sm'}>{m['edit.preview_failed']()}</div>;
  }

  if (!renderedNode) {
    // First render after a non-empty source change — keep the pane
    // calm rather than flashing a loading spinner mid-typing.
    return <div className={className ?? 'text-muted-foreground'}>{m['edit.preview_placeholder']()}</div>;
  }

  return <div className={className ?? 'crowi-prose min-w-0'}>{renderedNode}</div>;
}

// Preview-specific component overrides. We intentionally omit the show
// page's `<section>` wrapper + `<HeadingAnchor>` button — neither is
// useful in a 2-column preview pane (no URL hash to react to, no copy-
// link affordance needed for unsaved drafts).
type ChildrenProps = { children?: React.ReactNode };

const PREVIEW_HEADINGS = {
  h1: 'text-3xl font-bold tracking-tight mt-10 mb-4 first:mt-0 leading-tight',
  h2: 'text-2xl font-semibold tracking-tight mt-8 mb-3 first:mt-0 leading-snug',
  h3: 'text-xl font-semibold mt-6 mb-2 first:mt-0 leading-snug',
  h4: 'text-lg font-semibold mt-5 mb-2 first:mt-0',
  h5: 'text-base font-semibold mt-4 mb-2 first:mt-0',
  h6: 'text-sm font-semibold uppercase tracking-wide mt-4 mb-2 first:mt-0',
} as const;

type HeadingTag = keyof typeof PREVIEW_HEADINGS;

function makePreviewHeading(Tag: HeadingTag) {
  const Heading = ({ children, ...props }: ChildrenProps) => (
    <Tag className={PREVIEW_HEADINGS[Tag]} {...props}>
      {children}
    </Tag>
  );
  Heading.displayName = `PreviewHeading(${Tag})`;
  return Heading;
}

// Exported so tests can render this exact component map through
// `renderMdastToReactNode` directly (e.g. the page-view↔preview parity
// assertion in `page-content.test.tsx`, AC-B6) without going through
// the network-backed `MarkdownPreview` component itself.
export const previewComponents = {
  h1: makePreviewHeading('h1'),
  h2: makePreviewHeading('h2'),
  h3: makePreviewHeading('h3'),
  h4: makePreviewHeading('h4'),
  h5: makePreviewHeading('h5'),
  h6: makePreviewHeading('h6'),
  a: ({ href, children, ...props }: { href?: string; children?: React.ReactNode }) => {
    const external = isExternalHref(href);
    return (
      <a
        href={href}
        className="text-primary decoration-primary/30 hover:decoration-primary/70 underline underline-offset-[3px] transition-colors"
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        {...props}
      >
        {children}
      </a>
    );
  },
  code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
    // Inline code only — block code arrives as raw shiki <pre> HTML
    // and skips this component entirely.
    if (className) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="text-foreground font-mono text-[0.95em] before:content-none after:content-none" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: ChildrenProps) => (
    <pre
      className="bg-muted border border-border/60 rounded-xl px-4 py-3 my-6 text-[0.875rem] leading-relaxed font-mono overflow-x-auto max-w-full min-w-0"
      {...props}
    >
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
  // See `page-content.tsx` — `className` is merged (not spread) so the
  // GFM task-list markers survive into the Tailwind `[&.…]` variants.
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
  // GFM task-list checkbox — controlled + non-interactive, see
  // `page-content.tsx` for the React warning this resolves.
  input: ({ type, checked, ...props }: { type?: string; checked?: unknown; [key: string]: unknown }) =>
    type === 'checkbox' ? <input type="checkbox" checked={Boolean(checked)} readOnly {...props} /> : <input type={type} {...props} />,
  img: ({ src, alt, className, style: rawStyle, ...rest }: { src?: string | Blob; alt?: string; className?: unknown; style?: React.CSSProperties }) => {
    const srcString = typeof src === 'string' ? src : undefined;
    // Server-rendered diagram embed (PlantUML PNG fallback or Mermaid's
    // `<img>` success output) — wrap for cap-to-width + click-to-enlarge,
    // matching the show page.
    if (isDiagramEmbed(className)) {
      return (
        <DiagramEmbed className={typeof className === 'string' ? className : undefined}>
          {/* biome-ignore lint/performance/noImgElement: rich-text rendered as plain markdown */}
          <img src={srcString} alt={alt || ''} className="max-w-full h-auto" loading="lazy" />
        </DiagramEmbed>
      );
    }
    // RFC-0015 image display attributes — same img-layer helper as the
    // show page (`page-content.tsx`), so preview↔page-view parity
    // holds for the same input (AC-B6). An unrelated raw `<img>`'s own
    // `class`/`style` is MERGED (never replaced) with the base utility
    // classes / re-validated display style (AC-B3) — same
    // `mergeImageClassName`/`mergeImageStyle` helpers as the show page.
    const imgClassName = mergeImageClassName('max-w-full h-auto rounded-lg my-6', className);
    const displayStyle = getImageDisplayStyle(rest);
    const mergedStyle = mergeImageStyle(rawStyle, displayStyle);
    const restProps = stripImageDisplayTransportProps(rest);
    return (
      // biome-ignore lint/performance/noImgElement: rich-text rendered as plain markdown
      <img src={srcString} alt={alt || ''} className={imgClassName} loading="lazy" style={mergedStyle} {...restProps} />
    );
  },
  // RFC-0015 image display attributes — see `page-content.tsx`'s
  // `figure` override for the forged-marker-safe rationale (identical
  // logic here for preview↔page-view parity, AC-B6). The marker-less
  // branch passes every prop (including `style`) through ordinarily —
  // `style` is only dropped on the marker-bearing branch.
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
    // `props`'s declared type has no `style` field, so strip it via a
    // cast instead of destructuring a field TypeScript doesn't know
    // about.
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
  // PlantUML SVG embed (`<div class="diagram-embed plantuml-embed">`) —
  // same zoom wrapper as the show page. Mermaid's error placeholder is
  // also a `<div>` but deliberately lacks the `diagram-embed` marker
  // (spec §9), so it falls through to the plain-div branch below; other
  // raw-HTML <div>s render plainly too.
  div: ({ className, children, ...props }: ChildrenProps & { className?: unknown }) => {
    if (isDiagramEmbed(className)) {
      return <DiagramEmbed className={typeof className === 'string' ? className : undefined}>{children}</DiagramEmbed>;
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
