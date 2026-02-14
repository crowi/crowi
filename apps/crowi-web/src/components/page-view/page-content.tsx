'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PageWithRevision } from '@crowi/api-contract';

interface PageContentProps {
  page: PageWithRevision;
}

export function PageContent({ page }: PageContentProps) {
  const body = page.revision?.body || '';

  if (!body) {
    return (
      <div className="text-muted-foreground text-center py-8">
        This page has no content.
      </div>
    );
  }

  return (
    <div className="prose prose-slate dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Custom heading rendering with anchor links
          h1: ({ children, ...props }) => (
            <h1 className="text-2xl font-bold mt-8 mb-4 first:mt-0" {...props}>
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2 className="text-xl font-bold mt-6 mb-3" {...props}>
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 className="text-lg font-semibold mt-4 mb-2" {...props}>
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4 className="text-base font-semibold mt-3 mb-2" {...props}>
              {children}
            </h4>
          ),
          // Custom link rendering
          a: ({ href, children, ...props }) => {
            const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
            return (
              <a
                href={href}
                className="text-primary hover:underline"
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
                {...props}
              >
                {children}
              </a>
            );
          },
          // Custom code block rendering
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !className;

            if (isInline) {
              return (
                <code
                  className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono"
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
          // Custom pre (code block container) rendering
          pre: ({ children, ...props }) => (
            <pre
              className="bg-muted p-4 rounded-lg overflow-x-auto text-sm"
              {...props}
            >
              {children}
            </pre>
          ),
          // Custom blockquote rendering
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="border-l-4 border-primary/30 pl-4 italic text-muted-foreground"
              {...props}
            >
              {children}
            </blockquote>
          ),
          // Custom table rendering
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse border border-border" {...props}>
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th
              className="border border-border bg-muted px-4 py-2 text-left font-semibold"
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="border border-border px-4 py-2" {...props}>
              {children}
            </td>
          ),
          // Custom list rendering
          ul: ({ children, ...props }) => (
            <ul className="list-disc pl-6 space-y-1" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="list-decimal pl-6 space-y-1" {...props}>
              {children}
            </ol>
          ),
          // Custom image rendering
          img: ({ src, alt, ...props }) => (
            <img
              src={src}
              alt={alt || ''}
              className="max-w-full h-auto rounded-lg"
              loading="lazy"
              {...props}
            />
          ),
          // Custom horizontal rule
          hr: ({ ...props }) => <hr className="my-6 border-border" {...props} />,
          // Custom paragraph
          p: ({ children, ...props }) => (
            <p className="my-4 leading-7" {...props}>
              {children}
            </p>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
