import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { reactI18nextModule } from 'react-i18next'
import en from 'locales/en/translation.json'
import ja from 'locales/ja/translation.json'

i18n
  .use(LanguageDetector)
  .use(reactI18nextModule)
  .init({
    fallbackLng: 'en',
    debug: true,
    interpolation: { escapeValue: false },
    react: {
      wait: false,
      bindI18n: 'languageChanged loaded',
      bindStore: 'added removed',
      nsMode: 'default',
    },
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
  })

export default i18n
