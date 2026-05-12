import { defineI18n } from 'fumadocs-core/i18n';

export const locales = ['ja', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'ja';

export const i18n = defineI18n({
  defaultLanguage: defaultLocale,
  languages: locales as unknown as string[],
  hideLocale: 'never',
  parser: 'dir',
});

export const localeLabels: Record<Locale, string> = {
  ja: '日本語',
  en: 'English',
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
