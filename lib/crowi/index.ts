import Debug from 'debug'
import path, { sep } from 'path'
import { connect as mongooseConnect } from 'mongoose'
import Tokens from 'csrf'
import { createClient as createRedisClient, RedisClient } from 'redis'
import url from 'url'
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import connectRedis from 'connect-redis'
import express from 'express'
import session from 'express-session'
import errorHandler from 'errorhandler'
import morgan from 'morgan'
import dnscache from 'dnscache'
import models from 'server/models'
import events from 'server/events'
import middlewares from 'server/middlewares'
import controllers from 'server/controllers'
import routes from '../routes'
import LRU from '../service/lru'
import ConfigService from '../service/config'
import { hasSlackConfig } from '../models/config'
import mailer from 'server/util/mailer'
import slack from 'server/util/slack'
import expressInit from './express-init'
import Searcher from 'server/service/search'

const pkg = require('../../package.json')

type Models = { [K in keyof typeof models]: ReturnType<typeof models[K]> }

type Events = { [K in keyof typeof events]: InstanceType<typeof events[K]> }

type Middlewares = { [K in keyof ReturnType<typeof middlewares>]: ReturnType<typeof middlewares>[K] }

type Controllers = { [K in keyof ReturnType<typeof controllers>]: ReturnType<typeof controllers>[K] }

const debug = Debug('crowi:crowi')

class Crowi {
  version: string

  rootDir: string

  pluginDir: string

  publicDir: string

  localeDir: string

  resourceDir: string

  viewsDir: string

  mailDir: string

  viewsDirs: string[]

  tmpDir: string

  cacheDir: string

  app: any = null

  mongoose: any = null

  // FIXME after service/config typed
  config: any

  searcher: any = null

  mailer: any = {}

  lru: any = {}

  tokens: Tokens

  // FIXME: {} をアサインしないで済む方法を捜す
  models: Models = {} as any as Models

  events: Events = {} as any as Events

  middlewares: Middlewares = {} as any as Middlewares

  controllers: Controllers = {} as any as Controllers

  env: typeof process.env

  baseUrl: string | null = null

  node_env: string

  port: number

  redis: RedisClient | null = null

  redisUrl: string | null

  redisOpts: any

  // TODO: @types モジュール入れたらやる
  sessionConfig: any

  io?: SocketIOServer

  // FIXME: util/slack に型付けたらやる
  slack: any

  initialized = false

  constructor(rootdir: string, env: typeof process.env) {
    this.version = pkg.version

    this.env = env
    this.baseUrl = this.env.BASE_URL || null
    this.node_env = this.env.NODE_ENV || 'production'
    this.port = this.env.PORT ? Number.parseInt(this.env.PORT) : 3000
    this.redisUrl = this.env.REDISTOGO_URL || this.env.REDIS_URL || null
    this.redisOpts = this.buildRedisOpts(this.redisUrl)

    this.rootDir = rootdir
    this.pluginDir = path.join(this.rootDir, 'node_modules') + sep
    this.publicDir = path.join(this.rootDir, 'public') + sep
    this.localeDir = path.join(this.rootDir, 'locales') + sep
    this.resourceDir = path.join(this.rootDir, 'resource') + sep
    this.viewsDir = path.join(this.rootDir, 'views') + sep
    this.mailDir = path.join(this.viewsDir, 'mail') + sep
    const pagesDir = path.join(this.rootDir, ...(Crowi.isRunOnTsNode() ? ['lib'] : ['dist', 'server']), 'pages') + sep
    this.viewsDirs = [this.viewsDir, pagesDir]
    this.tmpDir = path.join(this.rootDir, 'tmp') + sep
    this.cacheDir = path.join(this.tmpDir, 'cache')

    this.setupEvents()

    this.tokens = new Tokens()
  }

  async init() {
    // setup database server and load all modesl
    await this.setupDatabase()
    await this.setupModels()
    await this.setupRedisClient()
    await this.setupSessionConfig()
    await this.setupConfig()
    await this.migrateConfig()
    await this.setupSearcher()
    await this.setupMailer()
    await this.setupSlack()
    await this.setupDNSCache()
    await this.setupLRU()
    await this.buildServer()

    this.initialized = true
  }

  isInitialized() {
    return this.initialized
  }

  static isRunOnTsNode(): boolean {
    try {
      if (process[Symbol.for('ts-node.register.instance')]) {
        return true
      }
    } finally {
      // pass
    }

    return false
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

  getConfigService(): ConfigService {
    return this.config
  }

  getBaseUrl() {
    if (this.baseUrl) {
      return this.baseUrl
    }
    const config = this.getConfig()
    if (config && config.crowi && config.crowi['app:url']) {
      return config.crowi['app:url']
    }

    // This might be happend when env BASE_URL is not set and this is not an express request.
    // While initialize express, config.crowi['app:url'] could be set be detecting accessing URL.
    return null
  }

  getEnv() {
    return this.env
  }

  buildRedisOpts(redisUrl: string | null) {
    if (redisUrl) {
      const { hostname: host, port, auth } = url.parse(redisUrl)
      const password = auth ? { password: auth.split(':')[1] } : {}
      return { host, port, ...password }
    }
    return null
  }

  // getter/setter of model instance
  //
  model<T extends keyof Models>(name: T, model?: Models[T]): Models[T] {
    if (model) {
      return (this.models[name] = model)
    }

    return this.models[name]
  }

  // getter/setter of event instance
  event<T extends keyof Events>(name: T, event?: Events[T]): Events[T] {
    if (event) {
      return (this.events[name] = event)
    }

    return this.events[name]
  }

  async setupDatabase() {
    // mongoUri = mongodb://user:password@host/dbname

    const mongoUri =
      this.env.MONGOLAB_URI || // for B.C.
      this.env.MONGODB_URI || // MONGOLAB changes their env name
      this.env.MONGOHQ_URL ||
      this.env.MONGO_URI ||
      'mongodb://localhost/crowi'

    const mongooseOptions = {
      useNewUrlParser: true,
      useFindAndModify: false,
      useCreateIndex: true,
      useUnifiedTopology: true,
    }
    try {
      this.mongoose = await mongooseConnect(mongoUri, mongooseOptions)
    } catch (e) {
      debug('DB Connect Error: ', e)
      debug('DB Connect Error: ', mongoUri)
      throw new Error("Cann't connect to Database Server.")
    }
  }

  async setupRedisClient() {
    if (this.redisOpts) {
      this.redis = createRedisClient(this.redisOpts)
    }
  }

  setupSessionConfig() {
    const sessionAge = 1000 * 3600 * 24 * 30
    const sessionConfig = {
      rolling: true,
      secret: this.env.SECRET_TOKEN || 'this is default session secret',
      resave: false,
      saveUninitialized: true,
      cookie: {
        httpOnly: true,
        maxAge: sessionAge,
      },
      store: undefined,
    }

    if (this.redis) {
      const RedisStore = connectRedis(session)
      sessionConfig.store = new RedisStore({
        prefix: 'crowi:sess:',
        client: this.redis,
      })
    }

    this.sessionConfig = sessionConfig
  }

  async setupModels() {
    const keys = Object.keys(models) as (keyof typeof models)[]
    keys.forEach((key) => {
      this.model(key, models[key](this))
    })
  }

  setupEvents() {
    return Object.entries(events).forEach(([key, Event]: any[]) => {
      this.event(key, new Event(this))
    })
  }

  getApp() {
    return this.app
  }

  getMongo() {
    return this.mongoose
  }

  getIo(): any {
    return this.io
  }

  getSearcher() {
    return this.searcher
  }

  getMailer() {
    return this.mailer
  }

  async setupConfig() {
    this.config = new ConfigService(this)

    return this.config.load()
  }

  async migrateConfig() {
    const Config = this.model('Config')

    return Config.migrate()
  }

  async setupSearcher() {
    const searcherUri = this.env.ELASTICSEARCH_URI || this.env.BONSAI_URL || null

    if (searcherUri) {
      try {
        this.searcher = new Searcher(this, searcherUri)
        this.searcher.initialize()
      } catch (e) {
        debug('Error on setup searcher', e)
        this.searcher = null
      }
    }
  }

  setupMailer() {
    this.mailer = mailer(this)
  }

  setupSlack() {
    const config = this.getConfig()

    if (!hasSlackConfig(config)) {
      this.slack = {}
    } else {
      this.slack = slack(this)
    }
  }

  async setupDNSCache() {
    /**
     * Enable dnscache
     * To prevent slow dns resolution in vm on linux.
     * In December 2018, linux kernel may have race in conntrack.
     * See: https://www.weave.works/blog/racy-conntrack-and-dns-lookup-timeouts
     */
    if (this.env.ENABLE_DNSCACHE !== 'true') return

    dnscache({ enable: true })
  }

  setupLRU() {
    this.lru = new LRU(this)
  }

  getTokens() {
    return this.tokens
  }

  start = () => {
    if (this.app === null) {
      throw new Error('Must call init() before start().')
    }

    const server = http.createServer(this.app).listen(this.port, () => {
      console.log('[' + this.node_env + '] Express server listening on port ' + this.port)
    })
    const io = new SocketIOServer(server, { transports: ['websocket'] })
    if (this.redisOpts && this.redis) {
      io.adapter(createAdapter(this.redis, this.redis.duplicate()))
      debug('Using socket.io-redis')
    }
    io.sockets.on('connection', (socket) => {
      debug('Websocket CONNECTED, socket.id:', socket.id)
    })

    this.io = io

    return this.app
  }

  buildServer() {
    const app = express()
    const env = this.node_env

    this.middlewares = middlewares(this, app)
    this.controllers = controllers(this, app)

    expressInit(this, app)
    routes(this, app)

    if (env == 'development') {
      // swig.setDefaults({ cache: false });
      app.use(errorHandler({ dumpExceptions: true, showStack: true }))
      app.use(morgan('dev'))
    }

    if (env == 'production') {
      app.use(morgan('combined'))
      app.use(function (err, req, res, next) {
        res.status(500)
        res.render('500.html', { error: err })
      })
    }

    this.app = app
    return app
  }

  exitOnError(err) {
    debug('Critical error occured.')
    console.error(err)
    console.error(err.stack)
    process.exit(1)
  }
}

export default Crowi
