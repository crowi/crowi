import { ArrowUpRightIcon, CheckIcon, CircleDashedIcon, GithubIcon, SparklesIcon } from 'lucide-react';
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

  const tickerLoop = [...dict.ticker, ...dict.ticker];

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden bg-[var(--cw-bg)] text-[var(--cw-fg)]">
      {/* ─── Status strip ─────────────────────────────────────────────────── */}
      <div className="relative z-10 border-b border-[var(--cw-line)] bg-[var(--cw-bg-strip)] backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-2 text-[var(--cw-fg-soft)]">
          <div className="font-mono-label flex items-center gap-3">
            <span className="pulse-dot inline-block size-1.5 rounded-full text-[var(--cw-ember)]" aria-hidden />
            <span className="text-[var(--cw-fg)]">{dict.statusStrip.label}</span>
            <span aria-hidden className="text-[var(--cw-teal)]">
              /
            </span>
            <span>{dict.statusStrip.value}</span>
          </div>
          <div className="font-mono-label hidden items-center gap-4 md:flex">
            <span>{dict.statusStrip.version}</span>
            <span aria-hidden className="text-[var(--cw-teal)]">
              /
            </span>
            <span className="text-[var(--cw-ember-soft)]">{dict.statusStrip.codename}</span>
          </div>
        </div>
      </div>

      {/* ─── Hero ─────────────────────────────────────────────────────────── */}
      <section className="grain relative overflow-hidden">
        <div className="ember-glow pointer-events-none absolute inset-0 -z-10" aria-hidden />
        {/* Faint editorial baseline grid lines */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.06]"
          style={{
            backgroundImage: 'linear-gradient(to right, var(--cw-fg) 1px, transparent 1px)',
            backgroundSize: '12.5% 100%',
          }}
        />

        <div className="mx-auto max-w-7xl px-6 pb-20 pt-16 md:pb-28 md:pt-24">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-10">
            {/* Left column — copy */}
            <div className="lg:col-span-7">
              <div className="reveal reveal-1 font-mono-label flex items-center gap-3 text-[var(--cw-ember-soft)]">
                <span aria-hidden className="inline-block h-px w-8 bg-[var(--cw-ember-soft)]" />
                {dict.hero.eyebrow}
              </div>

              <h1 className="mt-7 max-w-[12ch] text-balance text-[clamp(2.75rem,7.5vw,6.25rem)] font-medium leading-[0.95] tracking-[-0.025em]">
                <span className="reveal reveal-2 block">{dict.hero.headlineLead}</span>
                <span className="reveal reveal-3 block">
                  {dict.hero.headlineWiki}
                  <span aria-hidden className="mx-3 text-[var(--cw-teal)]">
                    {dict.hero.headlineDash}
                  </span>
                </span>
                <span className="reveal reveal-4 block font-semibold text-[var(--cw-ember-soft)]">{dict.hero.headlineReignited}</span>
              </h1>

              <p className="reveal reveal-5 mt-8 max-w-xl text-pretty text-base leading-relaxed text-[var(--cw-fg-soft)] md:text-lg">
                {dict.hero.intro}
                <span className="font-semibold text-[var(--cw-ember-soft)]">{dict.hero.introHighlight}</span>
                {dict.hero.introTail}
              </p>

              <div className="reveal reveal-5 mt-10 flex flex-wrap items-center gap-3">
                <a
                  href={ZENN_ARTICLE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex h-12 items-center gap-3 rounded-none bg-[var(--cw-ember)] px-6 text-sm font-medium text-[var(--cw-on-ember)] shadow-[0_0_0_1px_var(--cw-ember),0_18px_40px_-18px_oklch(0.74_0.165_18_/_0.7)] transition hover:opacity-90"
                >
                  <span>{dict.hero.ctaArticle}</span>
                  <ArrowUpRightIcon className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </a>
                <a
                  href={GITHUB_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex h-12 items-center gap-3 rounded-none border border-[var(--cw-line-strong)] bg-transparent px-6 text-sm font-medium text-[var(--cw-fg)] transition hover:border-[var(--cw-ember-soft)] hover:text-[var(--cw-ember-soft)]"
                >
                  <GithubIcon className="size-4" />
                  <span>{dict.hero.ctaGithub}</span>
                </a>
              </div>
            </div>

            {/* Right column — Reignite mark + stack */}
            <aside className="lg:col-span-5">
              <div className="relative">
                <div className="reignite-halo absolute inset-0 -z-10" aria-hidden />
                <Image src="/crowi-reignite.webp" alt={dict.hero.reigniteAlt} width={1920} height={1080} priority className="reveal reveal-2 h-auto w-full" />
              </div>

              {/* Stack table */}
              <div className="reveal reveal-5 mt-8 border-t border-[var(--cw-line-strong)]">
                <div className="font-mono-label flex items-center justify-between py-3 text-[var(--cw-muted)]">
                  <span>{dict.runtime.label}</span>
                  <span aria-hidden>↓</span>
                </div>
                <dl className="grid grid-cols-1 border-t border-[var(--cw-line)]">
                  {dict.runtime.items.map((row) => (
                    <div key={row.k} className="flex items-baseline justify-between gap-4 border-b border-[var(--cw-line)] py-2.5 text-sm last:border-b-0">
                      <dt className="font-mono-label text-[var(--cw-muted)]">{row.k}</dt>
                      <dd className="text-sm font-medium text-[var(--cw-fg)]">{row.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </aside>
          </div>
        </div>
      </section>

      {/* ─── Ticker / tagline marquee ─────────────────────────────────────── */}
      <section aria-hidden className="relative overflow-hidden border-y border-[var(--cw-line)] bg-[var(--cw-bg-strip)] py-5">
        <div className="marquee-track flex w-max items-center gap-12 whitespace-nowrap">
          {tickerLoop.map((word, i) => (
            <span key={`${word}-${i}`} className="flex items-center gap-12 text-xl font-medium tracking-tight text-[var(--cw-fg)] md:text-2xl">
              {word}
              <span aria-hidden className="text-[var(--cw-ember)]">
                ✦
              </span>
            </span>
          ))}
        </div>
      </section>

      {/* ─── Ch. 01 — About ───────────────────────────────────────────────── */}
      <section className="relative">
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <header className="max-w-3xl">
            <div className="font-mono-label flex items-center gap-3 text-[var(--cw-ember-soft)]">
              <span>{dict.about.chapter}</span>
              <span aria-hidden className="inline-block h-px w-10 bg-[var(--cw-line-strong)]" />
              <span className="text-[var(--cw-muted)]">{dict.about.kicker}</span>
            </div>
            <h2 className="mt-5 text-balance text-3xl font-medium leading-[1.15] tracking-tight md:text-4xl">{dict.about.title}</h2>
          </header>
          <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-12">
            <p className="text-pretty text-2xl font-medium leading-snug tracking-tight text-[var(--cw-fg)] lg:col-span-7 md:text-3xl">{dict.about.lede}</p>
            <p className="text-base leading-relaxed text-[var(--cw-fg-soft)] lg:col-span-5">{dict.about.description}</p>
          </div>
        </div>
      </section>

      {/* ─── Ch. 02 — Reignite items ──────────────────────────────────────── */}
      <section className="relative border-t border-[var(--cw-line)]">
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <header className="mb-12 grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-7">
              <div className="font-mono-label flex items-center gap-3 text-[var(--cw-ember-soft)]">
                <span>{dict.reignite.chapter}</span>
                <span aria-hidden className="inline-block h-px w-10 bg-[var(--cw-line-strong)]" />
                <span className="text-[var(--cw-muted)]">{dict.reignite.kicker}</span>
              </div>
              <h2 className="mt-6 text-balance text-4xl font-medium tracking-tight md:text-5xl">{dict.reignite.title}</h2>
            </div>
          </header>

          <ol className="border-t border-[var(--cw-line)]">
            {dict.reignite.items.map((item, idx) => (
              <li
                key={item.title}
                className="group grid grid-cols-1 items-baseline gap-4 border-b border-[var(--cw-line)] py-8 transition hover:bg-[var(--cw-surface-hover)] lg:grid-cols-12 lg:gap-8 lg:py-10"
              >
                <span className="font-mono-label text-[var(--cw-ember-soft)] lg:col-span-1">{String(idx + 1).padStart(2, '0')}</span>
                <h3 className="text-2xl font-medium leading-tight tracking-tight text-[var(--cw-fg)] lg:col-span-5 lg:text-3xl">{item.title}</h3>
                <p className="text-base leading-relaxed text-[var(--cw-fg-soft)] lg:col-span-6">{item.description}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ─── Ch. 03 — Migration status ────────────────────────────────────── */}
      <section className="relative border-t border-[var(--cw-line)]">
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <header className="max-w-3xl">
            <div className="font-mono-label flex items-center gap-3 text-[var(--cw-ember-soft)]">
              <span>{dict.status.chapter}</span>
              <span aria-hidden className="inline-block h-px w-10 bg-[var(--cw-line-strong)]" />
              <span className="text-[var(--cw-muted)]">{dict.status.kicker}</span>
            </div>
            <h2 className="mt-5 text-balance text-3xl font-medium leading-[1.15] tracking-tight md:text-4xl">{dict.status.title}</h2>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--cw-fg-soft)]">{dict.status.description}</p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex h-10 items-center gap-2 border border-[var(--cw-line-strong)] bg-transparent px-4 text-xs font-medium tracking-wide text-[var(--cw-fg)] transition hover:border-[var(--cw-ember-soft)] hover:text-[var(--cw-ember-soft)]"
              >
                <GithubIcon className="size-3.5" />
                <span>{dict.status.ctaGithub}</span>
              </a>
              <a
                href={GITHUB_ISSUES_URL}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex h-10 items-center gap-2 border border-[var(--cw-line-strong)] bg-transparent px-4 text-xs font-medium tracking-wide text-[var(--cw-fg)] transition hover:border-[var(--cw-ember-soft)] hover:text-[var(--cw-ember-soft)]"
              >
                <span>{dict.status.ctaIssues}</span>
                <ArrowUpRightIcon className="size-3.5" />
              </a>
            </div>
          </header>

          {/* New in v2 — genuinely new capabilities, not just migrated */}
          <div className="mt-14 border border-[var(--cw-ember-line)] p-6 lg:max-w-3xl">
            <div className="font-mono-label flex items-center gap-2 text-[var(--cw-ember)]">
              <SparklesIcon className="size-3.5" />
              <span>{dict.status.newLabel}</span>
            </div>
            <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {dict.status.newFeatures.map((n) => (
                <li key={n} className="flex items-baseline gap-3 text-sm text-[var(--cw-fg)]">
                  <span aria-hidden className="text-[var(--cw-ember)]">
                    ◆
                  </span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-10 sm:grid-cols-2 lg:max-w-3xl">
            {/* Done */}
            <div>
              <div className="font-mono-label flex items-center gap-2 text-[var(--cw-ember)]">
                <CheckIcon className="size-3.5" />
                <span>{dict.status.completedLabel}</span>
              </div>
              <ul className="mt-5 space-y-3 border-l border-[var(--cw-ember-line)] pl-5">
                {dict.status.completed.map((c) => (
                  <li key={c} className="flex items-baseline gap-3 text-sm text-[var(--cw-fg)]">
                    <span aria-hidden className="text-[var(--cw-ember)]">
                      ✓
                    </span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
            {/* In progress */}
            <div>
              <div className="font-mono-label flex items-center gap-2 text-[var(--cw-muted)]">
                <CircleDashedIcon className="size-3.5" />
                <span>{dict.status.upcomingLabel}</span>
              </div>
              <ul className="mt-5 space-y-3 border-l border-dashed border-[var(--cw-line-strong)] pl-5">
                {dict.status.upcoming.map((u) => (
                  <li key={u} className="flex items-baseline gap-3 text-sm text-[var(--cw-fg-soft)]">
                    <span aria-hidden className="text-[var(--cw-muted)]">
                      ○
                    </span>
                    <span>{u}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Footer ───────────────────────────────────────────────────────── */}
      <footer className="relative mt-auto border-t border-[var(--cw-line)] bg-[var(--cw-bg-strip)]">
        <div className="mx-auto max-w-7xl px-6 py-14">
          <div className="grid grid-cols-1 items-end gap-10 md:grid-cols-12">
            <div className="md:col-span-7">
              <p className="text-2xl font-medium leading-tight tracking-tight text-[var(--cw-fg)] md:text-3xl">{dict.footer.tagline}</p>
            </div>
            <nav className="font-mono-label flex flex-wrap items-center gap-5 text-[var(--cw-fg-soft)] md:col-span-5 md:justify-end">
              <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="transition hover:text-[var(--cw-ember-soft)]">
                {dict.footer.links.github}
              </a>
              <span aria-hidden className="text-[var(--cw-teal)]">
                ·
              </span>
              <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" className="transition hover:text-[var(--cw-ember-soft)]">
                {dict.footer.links.issues}
              </a>
              <span aria-hidden className="text-[var(--cw-teal)]">
                ·
              </span>
              <a href={ZENN_ARTICLE_URL} target="_blank" rel="noreferrer" className="transition hover:text-[var(--cw-ember-soft)]">
                {dict.footer.links.article}
              </a>
            </nav>
          </div>
          <div className="rule-hair my-8" />
          <div className="font-mono-label flex flex-col-reverse items-start justify-between gap-3 text-[var(--cw-muted)] md:flex-row md:items-center">
            <p>{dict.footer.copyright}</p>
            <p className="text-[var(--cw-fg-soft)]">{dict.statusStrip.codename}</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
