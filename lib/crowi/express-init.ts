import express, { Express, Request, Response } from 'express'
import methodOverride from 'method-override'
import passport from 'passport'
import session from 'express-session'
import flash from 'connect-flash'
import cons from 'consolidate'
import { expressReactViewEngine }  from 'server/util/expressReactView'
import Crowi from 'server/crowi'
import { ConfigSecurityRegistrationMode } from 'server/models/config'
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
      registrationMode: ConfigSecurityRegistrationMode,
    }

    next()
  })

  const reactViewExt = Crowi.isRunOnTsNode() ? 'tsx' : 'js'

  app.set('port', crowi.port)
  app.use(express.static(crowi.publicDir))
  app.engine('html', cons.swig)
  app.engine(reactViewExt, expressReactViewEngine())
  app.set('view cache', false)
  app.set('view engine', 'html')
  app.set('view engine', reactViewExt)
  app.set('views', crowi.viewsDirs)
  app.use(methodOverride())
  app.use(express.urlencoded({ extended: true, limit: '50mb' }))
  app.use(express.json({ limit: '50mb' }))
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
