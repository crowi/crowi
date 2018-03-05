'use strict';

module.exports = function(crowi, app) {
  var debug = require('debug')('crowi:crowi:express-init')
    , path           = require('path')
    , express        = require('express')
    , bodyParser     = require('body-parser')
    , cookieParser   = require('cookie-parser')
    , methodOverride = require('method-override')
    , passport       = require('passport')
    , session        = require('express-session')
    , basicAuth      = require('basic-auth-connect')
    , flash          = require('connect-flash')
    , swig           = require('swig-templates')
    , webpackAssets  = require('express-webpack-assets')
    , i18next        = require('i18next')
    , i18nFsBackend  = require('i18next-node-fs-backend')
    , i18nSprintf    = require('i18next-sprintf-postprocessor')
    , i18nMiddleware = require('i18next-express-middleware')
    , i18nUserSettingDetector  = require('../util/i18nUserSettingDetector')
    , env            = crowi.node_env
    , config         = crowi.getConfig()
    , middleware     = require('../util/middlewares')

    , Config = crowi.model('Config')
    , User = crowi.model('User')
    ;

  var lngDetector = new i18nMiddleware.LanguageDetector();
  lngDetector.addDetector(i18nUserSettingDetector);

  i18next
    .use(lngDetector)
    .use(i18nFsBackend)
    .use(i18nSprintf)
    .init({
      // debug: true,
      fallbackLng: [User.LANG_EN_US],
      whitelist: Object.keys(User.getLanguageLabels()).map((k) => User[k]),
      backend: {
        loadPath: crowi.localeDir + '{{lng}}/translation.json'
      },
      detection: {
        order: ['userSettingDetector', 'header', 'navigator'],
      },
      overloadTranslationOptionHandler: i18nSprintf.overloadTranslationOptionHandler
    });

  app.use(function(req, res, next) {
    var now = new Date()
      , baseUrl
      , tzoffset = -(config.crowi['app:timezone'] || 9) * 60 // for datez
      , Page = crowi.model('Page')
      , User = crowi.model('User')
      , Config = crowi.model('Config')
      ;

    app.set('tzoffset', tzoffset);

    req.config = config;
    req.csrfToken = null;

    config.crowi['app:url'] = baseUrl = (req.headers['x-forwarded-proto'] == 'https' ? 'https' : req.protocol) + '://' + req.get('host');

    res.locals.req      = req;
    res.locals.baseUrl  = baseUrl;
    res.locals.config   = config;
    res.locals.env      = env;
    res.locals.now      = now;
    res.locals.tzoffset = tzoffset;
    res.locals.consts   = {
        pageGrants: Page.getGrantLabels(),
        userStatus: User.getUserStatusLabels(),
        language:   User.getLanguageLabels(),
        restrictGuestMode: Config.getRestrictGuestModeLabels(),
        registrationMode: Config.getRegistrationModeLabels(),
    };
    res.locals.local_config = Config.getLocalconfig(config); // config for browser context

    next();
  });

  app.set('port', crowi.port);
  const staticOption = (crowi.node_env === 'production') ? {maxAge:'30d'} : {};
  app.use(express.static(crowi.publicDir, staticOption));
  app.engine('html', swig.renderFile);
  app.use(webpackAssets(
    path.join(crowi.publicDir, 'js/webpack-assets.json'),
    { devMode: (crowi.node_env === 'development') })
  );
  // app.set('view cache', false);  // Default: true in production, otherwise undefined. -- 2017.07.04 Yuki Takei
  app.set('view engine', 'html');
  app.set('views', crowi.viewsDir);
  app.use(methodOverride());
  app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
  app.use(bodyParser.json({limit: '50mb'}));
  app.use(cookieParser());
  app.use(session(crowi.sessionConfig));

  // Set basic auth middleware
  app.use(function(req, res, next) {
    if (req.query.access_token || req.body.access_token) {
      return next();
    }

    if (config.crowi['security:basicName'] && config.crowi['security:basicSecret']) {
      return basicAuth(
        config.crowi['security:basicName'],
        config.crowi['security:basicSecret'])(req, res, next);
    } else {
      next();
    }
  });

  // passport
  if (Config.isEnabledPassport(config)) {
    debug('initialize Passport')
    app.use(passport.initialize());
    app.use(passport.session());
  }

  app.use(flash());

  app.use(middleware.swigFilters(app, swig));
  app.use(middleware.swigFunctions(crowi, app));

  app.use(middleware.csrfKeyGenerator(crowi, app));

  // switch loginChecker
  if (Config.isEnabledPassport(config)) {
    app.use(middleware.loginCheckerForPassport(crowi, app));
  }
  else {
    app.use(middleware.loginChecker(crowi, app));
  }

  app.use(i18nMiddleware.handle(i18next));
};
