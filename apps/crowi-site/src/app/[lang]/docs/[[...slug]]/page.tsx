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

  // Resolve file-relative MDX links (e.g. ./encryption) against the page's
  // own URL — which already carries the locale prefix — instead of letting
  // the browser resolve them against the rendered path (which 404s under
  // `trailingSlash: false`, where /{lang}/docs has no trailing slash).
  //
  // The base must match the page's *source directory* so authoring uses the
  // standard markdown convention: `./sibling` = same folder, `../other/x` =
  // sibling folder. A folder-index page (the docs root, or any page that has
  // descendant pages) owns its URL as a directory, so its base is `url + /`.
  // A leaf page lives *inside* its parent folder, so its base strips the last
  // URL segment — otherwise `./sibling` would wrongly resolve to a child path
  // (e.g. /docs/operations/configuration/encryption instead of
  // /docs/operations/encryption).
  const isFolderIndex = source.getPages(lang).some((p) => p.url.startsWith(`${page.url}/`));
  const base = isFolderIndex ? `${page.url}/` : page.url.slice(0, page.url.lastIndexOf('/') + 1);
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
