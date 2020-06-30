import { Express } from 'express'
import Crowi from 'server/crowi'
import i18next from 'i18next'
import i18nFsBackend from 'i18next-node-fs-backend'
import i18nSprintf from 'i18next-sprintf-postprocessor'
import i18nMiddleware from 'i18next-express-middleware'
import i18nUserSettingDetector from 'server/util/i18nUserSettingDetector'

export default (crowi: Crowi, app: Express) => {
  const User = crowi.model('User')
  const lngDetector = new i18nMiddleware.LanguageDetector()
  lngDetector.addDetector(i18nUserSettingDetector)

  i18next
    .use(lngDetector)
    .use(i18nFsBackend)
    .use(i18nSprintf)
    .init({
      // debug: (crowi.node_env === 'development'),
      fallbackLng: [User.LANG_EN_US],
      whitelist: Object.keys(User.getLanguageLabels()).map((k) => User[k]),
      backend: {
        loadPath: crowi.localeDir + '{{lng}}/translation.yml',
      },
      detection: {
        order: ['userSettingDetector', 'header', 'navigator'],
      },
      overloadTranslationOptionHandler: i18nSprintf.overloadTranslationOptionHandler,
    })

  return i18nMiddleware.handle(i18next)
}
