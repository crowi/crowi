import 'server-only';
import type { Locale } from './i18n';

const dictionaries = {
  ja: () => import('@/dictionaries/ja.json').then((m) => m.default),
  en: () => import('@/dictionaries/en.json').then((m) => m.default),
};

export type Dictionary = Awaited<ReturnType<(typeof dictionaries)['ja']>>;

export const getDictionary = async (locale: Locale): Promise<Dictionary> => dictionaries[locale]();
