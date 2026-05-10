import { ArrowRightIcon, ExternalLinkIcon, GitForkIcon } from 'lucide-react';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getDictionary } from '@/lib/dictionaries';
import { isLocale } from '@/lib/i18n';

const ZENN_ARTICLE_URL = 'https://zenn.dev/sotarok/articles/34795a35a4ef74';
const GITHUB_REPO_URL = 'https://github.com/crowi/crowi';
const GITHUB_ISSUES_URL = 'https://github.com/crowi/crowi/issues';

export default async function MarketingHome({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <main className="flex flex-1 flex-col">
      <section className="relative overflow-hidden border-b">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-60"
          style={{
            background:
              'radial-gradient(ellipse at top, rgba(255, 110, 140, 0.18), transparent 60%), radial-gradient(ellipse at bottom, rgba(67, 103, 107, 0.10), transparent 70%)',
          }}
        />
        <div className="container mx-auto flex max-w-5xl flex-col items-center px-6 py-20 text-center md:py-28">
          <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium uppercase tracking-wider text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/40 dark:text-rose-200">
            {dict.hero.badge}
          </span>
          <div className="mt-8 w-full max-w-2xl">
            <Image src="/crowi-reignite.webp" alt={dict.hero.reigniteAlt} width={920} height={500} priority className="h-auto w-full" />
          </div>
          <h1 className="mt-10 text-balance text-3xl font-bold tracking-tight md:text-5xl">
            <span className="text-fd-primary">Crowi</span>
            <span className="mx-3 text-fd-muted-foreground">—</span>
            <span>{dict.tagline}</span>
          </h1>
          <p className="mt-5 max-w-2xl text-balance text-lg leading-relaxed text-fd-muted-foreground md:text-xl">{dict.subtitle}</p>
          <p className="mt-6 max-w-2xl text-balance text-base text-fd-muted-foreground">
            {dict.hero.intro}
            <span className="font-semibold text-rose-500">{dict.hero.introHighlight}</span>
            {dict.hero.introTail}
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <a
              href={ZENN_ARTICLE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-fd-primary px-6 font-medium text-fd-primary-foreground shadow-sm transition hover:opacity-90"
            >
              {dict.hero.ctaArticle}
              <ArrowRightIcon className="size-4" />
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-fd-background px-6 font-medium shadow-sm transition hover:bg-fd-accent"
            >
              <GitForkIcon className="size-4" />
              {dict.hero.ctaGithub}
            </a>
          </div>
        </div>
      </section>

      <section className="border-b">
        <div className="container mx-auto max-w-3xl px-6 py-16 text-center md:py-20">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{dict.about.title}</h2>
          <p className="mt-4 leading-relaxed text-fd-muted-foreground">{dict.about.description}</p>
        </div>
      </section>

      <section className="border-b">
        <div className="container mx-auto max-w-5xl px-6 py-20 md:py-24">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">{dict.reignite.title}</h2>
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {dict.reignite.items.map((item) => (
              <div key={item.title} className="rounded-lg border bg-fd-card p-6 shadow-sm">
                <h3 className="text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="container mx-auto max-w-3xl px-6 py-20 text-center md:py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{dict.status.title}</h2>
          <p className="mt-4 leading-relaxed text-fd-muted-foreground">{dict.status.description}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-fd-background px-5 text-sm font-medium shadow-sm transition hover:bg-fd-accent"
            >
              <GitForkIcon className="size-4" />
              {dict.status.ctaGithub}
            </a>
            <a
              href={GITHUB_ISSUES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-fd-background px-5 text-sm font-medium shadow-sm transition hover:bg-fd-accent"
            >
              <ExternalLinkIcon className="size-4" />
              {dict.status.ctaIssues}
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t bg-fd-secondary/30">
        <div className="container mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-fd-muted-foreground md:flex-row">
          <p>{dict.footer.copyright}</p>
          <nav className="flex gap-6">
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="hover:text-fd-foreground">
              {dict.footer.links.github}
            </a>
            <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-fd-foreground">
              {dict.footer.links.issues}
            </a>
            <a href={ZENN_ARTICLE_URL} target="_blank" rel="noreferrer" className="hover:text-fd-foreground">
              {dict.footer.links.article}
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
