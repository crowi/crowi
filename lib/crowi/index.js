'use strict'

const debug = require('debug')('crowi:crowi')
const pkg = require('../../package.json')
const path = require('path')
const sep = path.sep
const mongoose = require('mongoose')
const models = require('../models')

class Crowi {
  constructor(rootdir, env) {
    this.version = pkg.version

    this.rootDir = rootdir
    this.pluginDir = path.join(this.rootDir, 'node_modules') + sep
    this.publicDir = path.join(this.rootDir, 'public') + sep
    this.libDir = path.join(this.rootDir, 'lib') + sep
    this.eventsDir = path.join(this.libDir, 'events') + sep
    this.localeDir = path.join(this.rootDir, 'locales') + sep
    this.resourceDir = path.join(this.rootDir, 'resource') + sep
    this.viewsDir = path.join(this.libDir, 'views') + sep
    this.mailDir = path.join(this.viewsDir, 'mail') + sep
    this.tmpDir = path.join(this.rootDir, 'tmp') + sep
    this.cacheDir = path.join(this.tmpDir, 'cache')

    this.config = {}
    this.searcher = null
    this.mailer = {}
    this.lru = {}

    this.tokens = null

    this.models = {}

    this.env = env
    this.node_env = this.env.NODE_ENV || 'development'
    this.port = this.env.PORT || 3000
    this.redis = null
    this.redisUrl = this.env.REDISTOGO_URL || this.env.REDIS_URL || null
    this.redisOpts = this.buildRedisOpts(this.redisUrl)

    this.events = {
      user: new (require(this.eventsDir + 'user'))(this),
      page: new (require(this.eventsDir + 'page'))(this),
      search: new (require(this.eventsDir + 'search'))(this),
      bookmark: new (require(this.eventsDir + 'bookmark'))(this),
    }
  }

  async init() {
    // setup database server and load all modesl
    await this.setupDatabase()
    await this.setupModels()
    await this.setupRedisClient()
    await this.setupSessionConfig()
    await this.setupConfig()
    await this.setupSearcher()
    await this.setupMailer()
    await this.setupSlack()
    await this.setupCsrf()
    await this.setupDNSCache()
    await this.setupLRU()
  }

  isPageId(pageId) {
    if (!pageId) {
      return false
    }

    if (typeof pageId === 'string' && pageId.match(/^[\da-f]{24}$/)) {
      return true
    }
  }

  setConfig(config) {
    this.config.update(config)
  }

  getConfig() {
    return this.config.get()
  }

  getEnv() {
    return this.env
  }

  buildRedisOpts(redisUrl) {
    if (redisUrl) {
      const url = require('url')
      const { hostname: host, port, auth } = url.parse(redisUrl)
      const password = auth ? { password: auth.split(':')[1] } : {}
      return { host, port, ...password }
    }
    return null
  }

  // getter/setter of model instance
  //
  model(name, model) {
    if (model) {
      return (this.models[name] = model)
    }

    return this.models[name]
  }

  // getter/setter of event instance
  event(name, event) {
    if (event) {
      return (this.events[name] = event)
    }

    return this.events[name]
  }

  setupDatabase() {
    // mongoUri = mongodb://user:password@host/dbname
    mongoose.Promise = global.Promise

    var mongoUri =
      this.env.MONGOLAB_URI || // for B.C.
      this.env.MONGODB_URI || // MONGOLAB changes their env name
      this.env.MONGOHQ_URL ||
      this.env.MONGO_URI ||
      'mongodb://localhost/crowi'

    return new Promise(function(resolve, reject) {
      mongoose.connect(
        mongoUri,
        function(e) {
          if (e) {
            debug('DB Connect Error: ', e)
            debug('DB Connect Error: ', mongoUri)
            return reject(new Error("Cann't connect to Database Server."))
          }
          return resolve()
        },
      )
    })
  }

  async setupRedisClient() {
    if (this.redisOpts) {
      const redis = require('redis')
      const redisClient = redis.createClient(this.redisOpts)
      this.redis = redisClient
    }
  }

  setupSessionConfig() {
    const session = require('express-session')
    const sessionAge = 1000 * 3600 * 24 * 30
    const sessionConfig = {
      rolling: true,
      secret: this.env.SECRET_TOKEN || 'this is default session secret',
      resave: false,
      saveUninitialized: true,
      cookie: {
        maxAge: sessionAge,
      },
    }

    if (this.redis) {
      const RedisStore = require('connect-redis')(session)
      sessionConfig.store = new RedisStore({
        prefix: 'crowi:sess:',
        client: this.redis,
      })
    }

    this.sessionConfig = sessionConfig
  }

  setupModels() {
    return new Promise((resolve, reject) => {
      Object.keys(models).forEach(key => {
        this.model(key, models[key](this))
      })
      resolve()
    })
  }

  getIo() {
    return this.io
  }

  getSearcher() {
    return this.searcher
  }

  getMailer() {
    return this.mailer
  }

  async setupConfig() {
    const Config = require('../service/config')
    this.config = new Config(this)

    return this.config.load()
  }

  setupSearcher() {
    const searcherUri = this.env.ELASTICSEARCH_URI || this.env.BONSAI_URL || null

    return new Promise((resolve, reject) => {
      if (searcherUri) {
        try {
          this.searcher = new (require(path.join(this.libDir, 'util', 'search')))(this, searcherUri)

          // workaround
          setTimeout(() => {
            this.searcher.checkESVersion()
            this.searcher.ensureAlias()
          }, 5000)
        } catch (e) {
          debug('Error on setup searcher', e)
          this.searcher = null
        }
      }
      resolve()
    })
  }

  setupMailer() {
    this.mailer = require('../util/mailer')(this)
  }

  setupSlack() {
    const config = this.getConfig()
    const Config = this.model('Config')

    if (!Config.hasSlackConfig(config)) {
      this.slack = {}
    } else {
      this.slack = require('../util/slack')(this)
    }
  }

  setupCsrf() {
    const Tokens = require('csrf')
    this.tokens = new Tokens()
  }

  async setupDNSCache() {
    /**
     * Enable dnscache
     * To prevent slow dns resolution in vm on linux.
     * In December 2018, linux kernel may have race in conntrack.
     * See: https://www.weave.works/blog/racy-conntrack-and-dns-lookup-timeouts
     */
    if (this.env.ENABLE_DNSCACHE !== 'true') return

    require('dnscache')({ enable: true })
  }

  setupLRU() {
    const LRU = require('../service/lru')
    this.lru = new LRU(this)
  }

  getTokens() {
    return this.tokens
  }

  async start() {
    const http = require('http')

    const app = await this.buildServer()
    const server = http.createServer(app).listen(this.port, () => {
      console.log('[' + this.node_env + '] Express server listening on port ' + this.port)
    })
    const io = require('socket.io')(server, { transports: ['websocket'] })
    if (this.redisOpts) {
      const redisAdapter = require('socket.io-redis')
      io.adapter(redisAdapter(this.redisOpts))
      debug('Using socket.io-redis')
    }
    io.sockets.on('connection', socket => {
      debug('Websocket CONNECTED, socket.id:', socket.id)
    })

    this.io = io

    return app
  }

  buildServer() {
    const express = require('express')
    const errorHandler = require('errorhandler')
    const morgan = require('morgan')
    const app = express()
    const env = this.node_env

    require('./express-init')(this, app)
    require('../routes')(this, app)

    if (env == 'development') {
      // swig.setDefaults({ cache: false });
      app.use(errorHandler({ dumpExceptions: true, showStack: true }))
      app.use(morgan('dev'))
    }

    if (env == 'production') {
      app.use(morgan('combined'))
      app.use(function(err, req, res, next) {
        res.status(500)
        res.render('500', { error: err })
      })
    }

    return Promise.resolve(app)
  }

  exitOnError(err) {
    debug('Critical error occured.')
    console.error(err)
    console.error(err.stack)
    process.exit(1)
  }
}

module.exports = Crowi
