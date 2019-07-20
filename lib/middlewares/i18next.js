const i18next = require('i18next')
const i18nFsBackend = require('i18next-node-fs-backend')
const i18nSprintf = require('i18next-sprintf-postprocessor')
const i18nMiddleware = require('i18next-express-middleware')
const i18nUserSettingDetector = require('../util/i18nUserSettingDetector')

module.exports = (crowi, app) => {
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
      whitelist: Object.keys(User.getLanguageLabels()).map(k => User[k]),
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
