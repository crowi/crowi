import i18next from 'i18next'
import LngDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import enUs from 'locales/en-US/translation.yml'
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

  i18next
    .use(lngDetector)
    .use(initReactI18next)
    .init({
      fallbackLng: 'en-US',
      debug: process.env.NODE_ENV === 'development',
      interpolation: { escapeValue: false },
      resources: {
        en: { translation: enUs },
        ja: { translation: ja },
      },
      detection: {
        order: ['userSetting', 'querystring', 'cookie', 'localStorage', 'navigator', 'htmlTag', 'path', 'subdomain'],
      },
    })
}
