import { defineI18nUI } from 'fumadocs-ui/i18n';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { BookOpenIcon } from 'lucide-react';
import { i18n, type Locale } from './i18n';

/* I18n config for the Fumadocs `RootProvider` — locale display
 * names live here, JA-specific UI translations are filled in for
 * the few strings Fumadocs ships in English. */
export const i18nUI = defineI18nUI(i18n, {
  ja: {
    displayName: '日本語',
    search: '検索',
    searchNoResult: '見つかりませんでした',
    toc: '目次',
    tocNoHeadings: '見出しはありません',
    lastUpdate: '最終更新',
    chooseLanguage: '言語を選ぶ',
    nextPage: '次のページ',
    previousPage: '前のページ',
    chooseTheme: 'テーマ',
    editOnGithub: 'GitHub で編集',
  },
  en: {
    displayName: 'English',
  },
});

/* Shared layout options for both `HomeLayout` (LP) and `DocsLayout`.
 * Header nav links resolve to per-locale URLs so the same component
 * covers `/<locale>` and `/<locale>/docs`. */
export function baseOptions(locale: Locale): BaseLayoutProps {
  return {
    i18n: true,
    nav: {
      title: (
        <span className="font-semibold tracking-tight">
          <span className="text-fd-primary">Crowi</span>
        </span>
      ),
      url: `/${locale}/`,
    },
    githubUrl: 'https://github.com/crowi/crowi',
    links: [
      {
        type: 'main',
        text: locale === 'ja' ? 'ドキュメント' : 'Docs',
        url: `/${locale}/docs/`,
        icon: <BookOpenIcon />,
      },
    ],
  };
}
