import i18n from 'i18next'
import LngDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import en from 'locales/en/translation.yml'
import ja from 'locales/ja/translation.yml'

export default () => {
  const lngDetector = new LngDetector()
  lngDetector.addDetector({
    name: 'userSetting',
    lookup(options) {
      return window.APP_CONTEXT.user.language
    },
    cacheUserLanguage(lng, options) {},
  })

  i18n
    .use(lngDetector)
    .use(initReactI18next)
    .init({
      fallbackLng: 'en',
      debug: process.env.NODE_ENV === 'development',
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
      detection: {
        order: ['userSetting', 'querystring', 'cookie', 'localStorage', 'navigator', 'htmlTag', 'path', 'subdomain'],
      },
    })
}
