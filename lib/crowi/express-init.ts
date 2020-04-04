import express, { Express, Request, Response } from 'express'
import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import methodOverride from 'method-override'
import passport from 'passport'
import session from 'express-session'
import flash from 'connect-flash'
import cons from 'consolidate'
import expressReactViews from 'express-react-views'
import Crowi from 'server/crowi'

export default (crowi: Crowi, app: Express) => {
  // const debug = Debug('crowi:crowi:express-init')
  const env = crowi.node_env
  const middlewares = crowi.middlewares

  app.use(function(req: Request, res: Response, next) {
    const now = new Date()
    const config = crowi.getConfig()
    const tzoffset = -(config.crowi['app:timezone'] || 9) * 60 // for date
    const Page = crowi.model('Page')
    const User = crowi.model('User')
    const Config = crowi.model('Config')

    app.set('tzoffset', tzoffset)

    req.config = config
    req.csrfToken = null

    let baseUrl = crowi.baseUrl
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

    next()
  })

  const reactViews = expressReactViews.createEngine({
    babel:
      env === 'development'
        ? {
            presets: [['@babel/env', { targets: { node: 'current' } }], '@babel/react'],
            plugins: ['@babel/proposal-optional-chaining'],
          }
        : {
            presets: [],
            plugins: [],
          },
    transformViews: env === 'development',
  })

  app.set('port', crowi.port)
  app.use(express.static(crowi.publicDir))
  app.engine('html', cons.swig)
  app.engine('js', reactViews)
  app.engine('tsx', reactViews)
  app.set('view cache', false)
  app.set('view engine', 'html')
  app.set('view engine', 'js')
  app.set('view engine', 'tsx')
  app.set('views', crowi.viewsDirs)
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
}
