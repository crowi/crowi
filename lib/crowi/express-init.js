'use strict'

module.exports = function(crowi, app) {
  // var debug = require('debug')('crowi:crowi:express-init')
  var express = require('express')
  var bodyParser = require('body-parser')
  var cookieParser = require('cookie-parser')
  var methodOverride = require('method-override')
  var passport = require('passport')
  var session = require('express-session')
  var basicAuth = require('basic-auth-connect')
  var flash = require('connect-flash')
  var cons = require('consolidate')
  var swig = require('swig')
  var i18next = require('i18next')
  var i18nFsBackend = require('i18next-node-fs-backend')
  var i18nSprintf = require('i18next-sprintf-postprocessor')
  var i18nMiddleware = require('i18next-express-middleware')
  var i18nUserSettingDetector = require('../util/i18nUserSettingDetector')
  var env = crowi.node_env
  var middleware = require('../util/middlewares')

  var User = crowi.model('User')

  var lngDetector = new i18nMiddleware.LanguageDetector()
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

  app.use(function(req, res, next) {
    var now = new Date()
    var baseUrl
    var config = crowi.getConfig()
    var tzoffset = -(config.crowi['app:timezone'] || 9) * 60 // for date
    var Page = crowi.model('Page')
    var User = crowi.model('User')
    var Config = crowi.model('Config')

    app.set('tzoffset', tzoffset)

    req.config = config
    req.csrfToken = null

    config.crowi['app:url'] = baseUrl =
      (req.headers['x-forwarded-proto'] == 'https' ? 'https' : req.protocol) + '://' + req.get('host')

    res.locals.req = req
    res.locals.baseUrl = baseUrl
    res.locals.config = config
    res.locals.env = env
    res.locals.now = now
    res.locals.tzoffset = tzoffset
    res.locals.consts = {
      pageGrants: Page.getGrantLabels(),
      userStatus: User.getUserStatusLabels(),
      language: User.getLanguageLabels(),
      registrationMode: Config.getRegistrationModeLabels(),
    }
    res.locals.local_config = Config.getLocalconfig(config) // config for browser context

    next()
  })

  app.set('port', crowi.port)
  app.use(express.static(crowi.publicDir))
  app.engine('html', cons.swig)
  app.set('view cache', false)
  app.set('view engine', 'html')
  app.set('views', crowi.viewsDir)
  app.use(methodOverride())
  app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }))
  app.use(bodyParser.json({ limit: '50mb' }))
  app.use(cookieParser())
  app.use(session(crowi.sessionConfig))

  // Set basic auth middleware
  app.use(function(req, res, next) {
    var config = crowi.getConfig()
    if (req.query.access_token || req.body.access_token) {
      return next()
    }

    if (config.crowi['security:basicName'] && config.crowi['security:basicSecret']) {
      return basicAuth(config.crowi['security:basicName'], config.crowi['security:basicSecret'])(req, res, next)
    } else {
      next()
    }
  })

  app.use(passport.initialize())
  app.use(passport.session())

  app.use(flash())

  app.use(middleware.swigFilters(app, swig))
  app.use(middleware.swigFunctions(crowi, app))

  app.use(middleware.loginChecker(crowi, app))

  app.use(i18nMiddleware.handle(i18next))
  app.use((req, res, next) => {
    res.locals.user_config = { lang: req.i18n.language }
    next()
  })
}
