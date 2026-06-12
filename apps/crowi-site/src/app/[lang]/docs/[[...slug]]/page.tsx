import type { ComponentProps } from 'react';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';
import { isLocale } from '@/lib/i18n';
import { source } from '@/lib/source';

export default async function Page({ params }: { params: Promise<{ lang: string; slug?: string[] }> }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();

  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const MDX = page.data.body;

  // Resolve file-relative MDX links (e.g. ./getting-started) against the
  // page's own URL — which already carries the locale prefix — instead of
  // letting the browser resolve them against the rendered path. With
  // `trailingSlash: false` the docs index renders at /{lang}/docs (no
  // trailing slash), so a raw ./getting-started would resolve against
  // /{lang}/ and 404. Anchored on page.url so it is correct on every page.
  const base = page.url.endsWith('/') ? page.url : `${page.url}/`;
  const DefaultAnchor = defaultMdxComponents.a ?? 'a';
  const components = {
    ...defaultMdxComponents,
    a: ({ href, ...props }: ComponentProps<'a'>) => {
      const resolved = href && /^\.\.?\//.test(href) ? new URL(href, `http://_${base}`).pathname : href;
      return <DefaultAnchor href={resolved} {...props} />;
    },
  };

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={components} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug?: string[] }> }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const page = source.getPage(slug, lang);
  if (!page) return {};
  return {
    title: page.data.title,
    description: page.data.description,
  };
}
