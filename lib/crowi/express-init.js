'use strict'

module.exports = function(crowi, app) {
  // var debug = require('debug')('crowi:crowi:express-init')
  var express = require('express')
  var bodyParser = require('body-parser')
  var cookieParser = require('cookie-parser')
  var methodOverride = require('method-override')
  var passport = require('passport')
  var session = require('express-session')
  var flash = require('connect-flash')
  var cons = require('consolidate')
  var env = crowi.node_env
  const middlewares = crowi.middlewares

  app.use(function(req, res, next) {
    var now = new Date()
    var config = crowi.getConfig()
    var tzoffset = -(config.crowi['app:timezone'] || 9) * 60 // for date
    var Page = crowi.model('Page')
    var User = crowi.model('User')
    var Config = crowi.model('Config')

    app.set('tzoffset', tzoffset)

    req.config = config
    req.csrfToken = null

    let baseUrl = crowi.basUrl
    if (!baseUrl) {
      baseUrl = (req.headers['x-forwarded-proto'] == 'https' ? 'https' : req.protocol) + '://' + req.get('host')
    }

    // FIXME:
    // This ... is accidentally working.
    // This `config` is now service/config object. (Originally, that was an object of configs)
    // And service/config has crowi object on its own property.
    // So, this config.crowi is Crowi Object and config.crowi['app:url'] means, accessing Crowi object's public property (create and assign the value)
    // It has to be fixed to set values into service/config.
    config.crowi['app:url'] = baseUrl

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
  app.use(middlewares.BasicAuth)

  app.use(passport.initialize())
  app.use(passport.session())

  app.use(flash())

  app.use(middlewares.SwigFilters)
  app.use(middlewares.SwigFunctions)

  app.use(middlewares.LoginChecker)

  app.use(middlewares.I18next)
  app.use(middlewares.ClientContext)
}
