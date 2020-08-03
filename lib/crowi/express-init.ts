import express, { Express, Request, Response } from 'express'
import bodyParser from 'body-parser'
import methodOverride from 'method-override'
import passport from 'passport'
import session from 'express-session'
import flash from 'connect-flash'
import cons from 'consolidate'
import expressReactViews from 'express-react-views'
import Crowi from 'server/crowi'
import { registrationMode } from 'server/models/config'
import Debug from 'debug'

export default (crowi: Crowi, app: Express) => {
  const debug = Debug('crowi:crowi:express-init')
  const env = crowi.node_env
  const middlewares = crowi.middlewares

  app.use(function (req: Request, res: Response, next) {
    debug('Route request', req.method, req.url)
    const now = new Date()
    const config = crowi.getConfig()
    const tzoffset = -(config.crowi['app:timezone'] || 9) * 60 // for date
    const Page = crowi.model('Page')
    const User = crowi.model('User')

    app.set('tzoffset', tzoffset)

    req.config = config
    req.csrfToken = null

    res.locals.req = req
    res.locals.baseUrl = crowi.getBaseUrl()
    res.locals.config = config
    res.locals.env = env
    res.locals.now = now
    res.locals.tzoffset = tzoffset
    res.locals.consts = {
      pageGrants: Page.getGrantLabels(),
      userStatus: User.getUserStatusLabels(),
      language: User.getLanguageLabels(),
      registrationMode,
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
