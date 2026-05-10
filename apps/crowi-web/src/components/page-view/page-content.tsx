'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Link2, X } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface PageContentProps {
  page: PageWithRevision;
}

// Inline mdast subset — keeps the plugin dep-free (no @types/mdast).
type MdastLike = {
  type?: string;
  value?: string;
  children?: MdastLike[];
  data?: { hProperties?: Record<string, unknown> };
};

// Inline hast subset, same reason.
type HastLike = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
};

// Index-aligned stamper: walk headings in document order and stamp
// each with the matching server-computed anchorId. Avoids running a
// second slugger client-side, which had a parity risk against the
// regex-based extractor on the server.
const buildRemarkHeadingIds = (anchorIds: ReadonlyArray<string>) => () => (tree: MdastLike) => {
  let i = 0;
  walk(tree);

  function walk(node: MdastLike) {
    if (node.type === 'heading') {
      const id = anchorIds[i];
      if (id !== undefined) {
        node.data = node.data || {};
        node.data.hProperties = { ...(node.data.hProperties || {}), id };
      }
      i++;
    }
    node.children?.forEach(walk);
  }
};

// Wrap each heading + its following sibling content in `<section
// data-section-id="…">`. The heading keeps its `id` so anchor jumps
// land on the heading; the section exists so we can highlight the
// whole block when its heading is the URL fragment target.
const HEADING_RE = /^h[1-6]$/;
const rehypeWrapSection = () => (tree: HastLike) => {
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
};

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
  // react-markdown attaches the underlying hast node here so plugins
  // can re-read attributes the React typing dropped on the floor.
  node?: { properties?: Record<string, unknown> };
}

function TargetedSection({ children, node, ...rest }: TargetedSectionProps) {
  const { hash: targetHash, clear } = useContext(TargetHashContext);
  // react-markdown's typing strips data-* off the props bag in some
  // versions; fall back to the hast node properties.
  const restRecord = rest as unknown as Record<string, string | undefined>;
  const sectionId: string | undefined =
    restRecord['data-section-id'] ??
    restRecord.dataSectionId ??
    (node?.properties?.['data-section-id'] as string | undefined) ??
    (node?.properties?.dataSectionId as string | undefined);
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

const REHYPE_PLUGINS = [rehypeWrapSection];

function readHashFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return decodeURIComponent(window.location.hash.slice(1));
}

export function PageContent({ page }: PageContentProps) {
  const body = page.revision?.body || '';
  const tocEntries = page.revision?.meta?.toc;

  const [targetHash, setTargetHash] = useState<string>(readHashFromLocation);

  // Listen for in-page nav (TOC clicks, anchor-link copies, browser back/forward)
  // and re-sync after hydration in case the initial useState ran on the server
  // where `window.location` was a stub.
  useEffect(() => {
    setTargetHash(readHashFromLocation());
    const onHashChange = () => setTargetHash(readHashFromLocation());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Strip the hash without scrolling (replaceState skips the
  // hashchange event, so we sync state by hand).
  const clearTarget = useCallback(() => {
    if (typeof window === 'undefined') return;
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setTargetHash('');
  }, []);

  const targetHashContextValue = useMemo<TargetHashContextValue>(() => ({ hash: targetHash, clear: clearTarget }), [targetHash, clearTarget]);

  // Plugin array — recompute only when the heading set changes so
  // ReactMarkdown's parse pipeline isn't re-run on unrelated renders.
  const remarkPlugins = useMemo(() => {
    const ids = tocEntries?.map((t) => t.anchorId) ?? [];
    return [remarkGfm, buildRemarkHeadingIds(ids)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocEntries?.map((t) => t.anchorId).join('|')]);

  // Stable components map. Once-per-mount via useMemo([]) so
  // ReactMarkdown doesn't see a new identity on unrelated renders.
  const components = useMemo(
    () => ({
      section: TargetedSection,
      h1: ({ children, id, ...props }: { children?: React.ReactNode; id?: string }) => (
        <h1 id={id} className="group/heading relative text-3xl font-bold tracking-tight mt-12 mb-4 first:mt-0 leading-tight scroll-mt-24" {...props}>
          <HeadingAnchor id={id} />
          {children}
        </h1>
      ),
      h2: ({ children, id, ...props }: { children?: React.ReactNode; id?: string }) => (
        <h2 id={id} className="group/heading relative text-2xl font-semibold tracking-tight mt-10 mb-3 first:mt-0 leading-snug scroll-mt-24" {...props}>
          <HeadingAnchor id={id} />
          {children}
        </h2>
      ),
      h3: ({ children, id, ...props }: { children?: React.ReactNode; id?: string }) => (
        <h3 id={id} className="group/heading relative text-xl font-semibold mt-8 mb-2 first:mt-0 leading-snug scroll-mt-24" {...props}>
          <HeadingAnchor id={id} />
          {children}
        </h3>
      ),
      h4: ({ children, id, ...props }: { children?: React.ReactNode; id?: string }) => (
        <h4 id={id} className="group/heading relative text-lg font-semibold mt-6 mb-2 first:mt-0 scroll-mt-24" {...props}>
          <HeadingAnchor id={id} />
          {children}
        </h4>
      ),
      h5: ({ children, id, ...props }: { children?: React.ReactNode; id?: string }) => (
        <h5 id={id} className="group/heading relative text-base font-semibold mt-5 mb-2 first:mt-0 scroll-mt-24" {...props}>
          <HeadingAnchor id={id} />
          {children}
        </h5>
      ),
      h6: ({ children, id, ...props }: { children?: React.ReactNode; id?: string }) => (
        <h6 id={id} className="group/heading relative text-sm font-semibold uppercase tracking-wide mt-5 mb-2 first:mt-0 scroll-mt-24" {...props}>
          <HeadingAnchor id={id} />
          {children}
        </h6>
      ),
      a: ({ href, children, ...props }: { href?: string; children?: React.ReactNode }) => {
        const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
        return (
          <a
            href={href}
            className="text-primary decoration-primary/30 hover:decoration-primary/70 underline underline-offset-[3px] transition-colors"
            target={isExternal ? '_blank' : undefined}
            rel={isExternal ? 'noopener noreferrer' : undefined}
            {...props}
          >
            {children}
          </a>
        );
      },
      code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
        const match = /language-(\w+)/.exec(className || '');
        const isInline = !match && !className;
        if (isInline) {
          return (
            <code
              className="bg-muted/70 text-foreground/90 px-[0.4em] py-[0.15em] rounded text-[0.875em] font-mono before:content-none after:content-none"
              {...props}
            >
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
      pre: ({ children, ...props }: { children?: React.ReactNode }) => (
        <pre className="bg-muted/60 border border-border/60 rounded-xl px-4 py-3 my-6 text-[0.875rem] leading-relaxed font-mono overflow-x-auto" {...props}>
          {children}
        </pre>
      ),
      blockquote: ({ children, ...props }: { children?: React.ReactNode }) => (
        <blockquote className="border-l-2 border-foreground/25 pl-4 my-6 text-foreground/75 [&>p]:my-2" {...props}>
          {children}
        </blockquote>
      ),
      table: ({ children, ...props }: { children?: React.ReactNode }) => (
        <div className="my-6 overflow-x-auto">
          <table className="w-full border-collapse text-sm" {...props}>
            {children}
          </table>
        </div>
      ),
      thead: ({ children, ...props }: { children?: React.ReactNode }) => (
        <thead className="border-b border-foreground/15" {...props}>
          {children}
        </thead>
      ),
      tbody: ({ children, ...props }: { children?: React.ReactNode }) => (
        <tbody className="[&>tr]:border-b [&>tr]:border-foreground/10 [&>tr:last-child]:border-0" {...props}>
          {children}
        </tbody>
      ),
      th: ({ children, ...props }: { children?: React.ReactNode }) => (
        <th className="px-3 py-2 text-left font-semibold text-foreground/80 align-top" {...props}>
          {children}
        </th>
      ),
      td: ({ children, ...props }: { children?: React.ReactNode }) => (
        <td className="px-3 py-2 align-top" {...props}>
          {children}
        </td>
      ),
      ul: ({ children, ...props }: { children?: React.ReactNode }) => (
        <ul className="list-disc pl-6 my-4 space-y-1.5 marker:text-foreground/40" {...props}>
          {children}
        </ul>
      ),
      ol: ({ children, ...props }: { children?: React.ReactNode }) => (
        <ol className="list-decimal pl-6 my-4 space-y-1.5 marker:text-foreground/40" {...props}>
          {children}
        </ol>
      ),
      li: ({ children, ...props }: { children?: React.ReactNode }) => (
        <li className="leading-relaxed [&>p]:my-1" {...props}>
          {children}
        </li>
      ),
      img: ({ src, alt, ...props }: { src?: string | Blob; alt?: string }) => (
        // biome-ignore lint/performance/noImgElement: rich-text rendered as plain markdown
        <img src={typeof src === 'string' ? src : undefined} alt={alt || ''} className="max-w-full h-auto rounded-lg my-6" loading="lazy" {...props} />
      ),
      hr: ({ ...props }) => <hr className="my-10 border-foreground/10" {...props} />,
      p: ({ children, ...props }: { children?: React.ReactNode }) => (
        <p className="my-4 leading-[1.7] text-foreground/90" {...props}>
          {children}
        </p>
      ),
      strong: ({ children, ...props }: { children?: React.ReactNode }) => (
        <strong className="font-semibold text-foreground" {...props}>
          {children}
        </strong>
      ),
    }),
    [],
  );

  // Initial scroll. The browser's native anchor jump fires before
  // ReactMarkdown commits, so the heading isn't there yet. Watch the
  // document with a MutationObserver until it appears, then scroll.
  // Bound by a 5s safety timeout.
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

  return (
    <TargetHashContext.Provider value={targetHashContextValue}>
      <div className="crowi-prose">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={REHYPE_PLUGINS} components={components}>
          {body}
        </ReactMarkdown>
      </div>
    </TargetHashContext.Provider>
  );
}
