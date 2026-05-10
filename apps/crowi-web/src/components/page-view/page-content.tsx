'use client';

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PageWithRevision } from '@crowi/api-contract';

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

// Index-aligned stamper: walk headings in document order and stamp
// each with the matching server-computed anchorId. Avoids running a
// second slugger client-side, which had a parity risk against the
// regex-based extractor on the server (image-in-heading, inline HTML).
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

export function PageContent({ page }: PageContentProps) {
  const body = page.revision?.body || '';
  const tocEntries = page.revision?.meta?.toc;

  // Recompute the plugin array only when the heading set changes.
  // ReactMarkdown re-parses if `remarkPlugins` identity changes, so we
  // memo on the joined anchor ids (cheap and stable).
  const remarkPlugins = useMemo(() => {
    const ids = tocEntries?.map((t) => t.anchorId) ?? [];
    return [remarkGfm, buildRemarkHeadingIds(ids)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocEntries?.map((t) => t.anchorId).join('|')]);

  if (!body) {
    return <div className="text-muted-foreground text-center py-8">This page has no content.</div>;
  }

  return (
    <div className="crowi-prose">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={{
          h1: ({ children, ...props }) => (
            <h1 className="text-3xl font-bold tracking-tight mt-12 mb-4 first:mt-0 leading-tight scroll-mt-24" {...props}>
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2 className="text-2xl font-semibold tracking-tight mt-10 mb-3 leading-snug scroll-mt-24" {...props}>
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 className="text-xl font-semibold mt-8 mb-2 leading-snug scroll-mt-24" {...props}>
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4 className="text-lg font-semibold mt-6 mb-2 scroll-mt-24" {...props}>
              {children}
            </h4>
          ),
          h5: ({ children, ...props }) => (
            <h5 className="text-base font-semibold mt-5 mb-2 scroll-mt-24" {...props}>
              {children}
            </h5>
          ),
          h6: ({ children, ...props }) => (
            <h6 className="text-sm font-semibold uppercase tracking-wide mt-5 mb-2 scroll-mt-24" {...props}>
              {children}
            </h6>
          ),

          a: ({ href, children, ...props }) => {
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

          code: ({ className, children, ...props }) => {
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

          pre: ({ children, ...props }) => (
            <pre className="bg-muted/60 border border-border/60 rounded-xl px-4 py-3 my-6 text-[0.875rem] leading-relaxed font-mono overflow-x-auto" {...props}>
              {children}
            </pre>
          ),

          blockquote: ({ children, ...props }) => (
            <blockquote className="border-l-2 border-foreground/25 pl-4 my-6 text-foreground/75 [&>p]:my-2" {...props}>
              {children}
            </blockquote>
          ),

          table: ({ children, ...props }) => (
            <div className="my-6 overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...props}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead className="border-b border-foreground/15" {...props}>
              {children}
            </thead>
          ),
          tbody: ({ children, ...props }) => (
            <tbody className="[&>tr]:border-b [&>tr]:border-foreground/10 [&>tr:last-child]:border-0" {...props}>
              {children}
            </tbody>
          ),
          th: ({ children, ...props }) => (
            <th className="px-3 py-2 text-left font-semibold text-foreground/80 align-top" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="px-3 py-2 align-top" {...props}>
              {children}
            </td>
          ),

          ul: ({ children, ...props }) => (
            <ul className="list-disc pl-6 my-4 space-y-1.5 marker:text-foreground/40" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="list-decimal pl-6 my-4 space-y-1.5 marker:text-foreground/40" {...props}>
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => (
            <li className="leading-relaxed [&>p]:my-1" {...props}>
              {children}
            </li>
          ),

          img: ({ src, alt, ...props }) => <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg my-6" loading="lazy" {...props} />,

          hr: ({ ...props }) => <hr className="my-10 border-foreground/10" {...props} />,

          p: ({ children, ...props }) => (
            <p className="my-4 leading-[1.7] text-foreground/90" {...props}>
              {children}
            </p>
          ),

          strong: ({ children, ...props }) => (
            <strong className="font-semibold text-foreground" {...props}>
              {children}
            </strong>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
