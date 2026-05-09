import Debug from 'debug';
import path, { sep } from 'path';
import mongoose from 'mongoose';
import Tokens from 'csrf';
import { createClient } from 'redis';
import url from 'url';
import http from 'http';
// import socketIO from 'socket.io'
// import socketIORedis from 'socket.io-redis'
import RedisStore from 'connect-redis';
import express from 'express';
import session from 'express-session';
import errorHandler from 'errorhandler';
import morgan from 'morgan';
import dnscache from 'dnscache';
import models from 'src/models';
import events from 'src/events';
import middlewares from 'src/middlewares';
import controllers from 'src/controllers';
import routes from '../routes';
import LRU from '../service/lru';
import ConfigService from '../service/config';
import { hasSlackConfig } from '../models/config';
import mailer from 'src/util/mailer';
import slack from 'src/util/slack';
import { resetKeyProvider } from 'src/util/crypto';
import { PluginManager, type PluginRegistries } from 'src/plugin';
import { runAwsConfigMigration } from 'src/util/aws-config-migration';
import expressInit from './express-init';
// import Searcher from 'src/service/search'

const pkg = require('../../package.json');

type Models = { [K in keyof typeof models]: ReturnType<(typeof models)[K]> };

type Events = { [K in keyof typeof events]: InstanceType<(typeof events)[K]> };

type Middlewares = { [K in keyof ReturnType<typeof middlewares>]: ReturnType<typeof middlewares>[K] };

export type Controllers = { [K in keyof ReturnType<typeof controllers>]: ReturnType<typeof controllers>[K] };

const debug = Debug('crowi:crowi');

class Crowi {
  version: string;

  rootDir: string;

  pluginDir: string;

  publicDir: string;

  resourceDir: string;

  viewsDir: string;

  mailDir: string;

  viewsDirs: string[];

  tmpDir: string;

  cacheDir: string;

  app: any = null;

  mongoose: any = null;

  // FIXME after service/config typed
  config: any;

  searcher: any = null;

  mailer: any = {};

  lru: any = {};

  tokens: Tokens;

  // FIXME: {} をアサインしないで済む方法を捜す
  models: Models = {} as any as Models;

  events: Events = {} as any as Events;

  middlewares: Middlewares = {} as any as Middlewares;

  controllers: Controllers = {} as any as Controllers;

  env: typeof process.env;

  baseUrl: string | null = null;

  node_env: string;

  port: number;

  redis: any = null;

  redisUrl: string | null;

  redisOpts: any;

  // TODO: @types モジュール入れたらやる
  sessionConfig: any;

  // io?: socketIO.Server

  // FIXME: util/slack に型付けたらやる
  slack: any;

  /**
   * PluginManager + resolved registries. Available after `setupPlugins`
   * runs in `init()`. `null` until then so a half-booted process is
   * obvious in stack traces.
   */
  pluginManager: PluginManager | null = null;

  pluginRegistries: PluginRegistries | null = null;

  initialized = false;

  constructor(rootdir: string, env: typeof process.env) {
    this.version = pkg.version;

    this.env = env;
    this.baseUrl = this.env.BASE_URL || null;
    this.node_env = this.env.NODE_ENV || 'production';
    this.port = this.env.PORT ? Number.parseInt(this.env.PORT) : 3000;
    // Remove REDISTOGO_URL in the near future.
    this.redisUrl = this.env.REDISTOGO_URL || this.env.REDIS_TLS_URL || this.env.REDIS_URL || null;

    const redisRejectUnauthorized = this.env.REDIS_REJECT_UNAUTHORIZED !== '0';
    this.redisOpts = this.buildRedisOpts(this.redisUrl, redisRejectUnauthorized);

    this.rootDir = rootdir;
    this.pluginDir = path.join(this.rootDir, 'node_modules') + sep;
    this.publicDir = path.join(this.rootDir, 'public') + sep;
    this.resourceDir = path.join(this.rootDir, 'resource') + sep;
    this.viewsDir = path.join(this.rootDir, 'views') + sep;
    this.mailDir = path.join(this.viewsDir, 'mail') + sep;
    const pagesDir = path.join(this.rootDir, ...(this.node_env === 'development' ? ['lib'] : ['dist', 'server']), 'pages') + sep;
    this.viewsDirs = [this.viewsDir, pagesDir];
    this.tmpDir = path.join(this.rootDir, 'tmp') + sep;
    this.cacheDir = path.join(this.tmpDir, 'cache');

    this.setupEvents();

    this.tokens = new Tokens();
  }

  async init() {
    this.setupEncryption();
    await this.setupDatabase();
    await this.setupModels();
    await this.setupRedisClient();
    await this.setupSessionConfig();
    await this.setupConfig();
    await this.migrateConfig();
    // Copy legacy `upload:aws:*` keys into the new plugin namespace
    // BEFORE setupPlugins runs — @crowi/plugin-aws reads its config at
    // register time and the storage driver pulls credentials out then.
    // Idempotent + write-only-when-target-empty, safe on every boot.
    // Failures here are warnings only: the migration is best-effort and
    // operators can also configure the new keys directly.
    try {
      await runAwsConfigMigration(this);
    } catch (err) {
      console.warn('[crowi] AWS config migration failed (continuing boot):', (err as Error).message);
    }
    // Plugins must boot AFTER config/models are ready (so PluginContext
    // can read config and access models) but BEFORE the legacy
    // searcher / mailer / slack initialisers — those are migrating to
    // plugin-provided drivers and any conflict should fail noisily here.
    await this.setupPlugins();
    await this.setupSearcher();
    await this.setupMailer();
    await this.setupSlack();
    await this.setupDNSCache();
    await this.setupLRU();
    await this.buildServer();

    this.initialized = true;
  }

  /**
   * Lightweight init for the `@crowi/admin-cli` operator CLI. Brings up
   * just what's needed to read Config + reach storage drivers — Redis
   * / sessions / mailer / slack / search / DNS / LRU / express / the
   * boot-time AWS migration are all skipped (the migration belongs to
   * `init()` so the long-running server runs it once; the CLI shouldn't
   * mutate Mongo as a side effect of starting up).
   *
   * `setupConfig` works without Redis because `service/config.ts:setupPubSub`
   * short-circuits when `redisOpts === null`.
   *
   * The CLI follows up with `teardownForCli()` to disconnect Mongo so
   * the Node process exits cleanly.
   */
  async initForCli() {
    this.setupEncryption();
    await this.setupDatabase();
    await this.setupModels();
    await this.setupConfig();
    await this.setupPlugins();
    this.initialized = true;
  }

  /**
   * Reverse of `initForCli`. Closes any connection the CLI helper opened
   * so the Node process exits without dangling handles. Defensive about
   * Redis (we never opened it in CLI mode, but a future helper might).
   */
  async teardownForCli() {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // best-effort — process is exiting anyway
      }
      this.redis = null;
    }
    if (this.mongoose) {
      await this.mongoose.disconnect();
      this.mongoose = null;
    }
  }

  async setupPlugins() {
    this.pluginManager = new PluginManager(this);
    this.pluginRegistries = await this.pluginManager.bootstrap();
    const loaded = this.pluginManager.getLoadedPlugins();
    console.log(`[crowi] Loaded ${loaded.length} plugin(s): ${loaded.map((p) => `${p.name}@${p.version}`).join(', ')}`);
  }

  /**
   * Active storage / search / auth / notifier drivers resolved from
   * `crowi.config.json`. Throws if accessed before `setupPlugins` ran.
   */
  getPlugins(): PluginRegistries {
    if (!this.pluginRegistries) {
      throw new Error('PluginManager has not been bootstrapped yet — call init() first.');
    }
    return this.pluginRegistries;
  }

  isInitialized() {
    return this.initialized;
  }

  isPageId(pageId) {
    if (!pageId) {
      return false;
    }

    if (typeof pageId === 'string' && pageId.match(/^[\da-f]{24}$/)) {
      return true;
    }
  }

  setConfig(config) {
    this.config.update(config);
  }

  getConfig() {
    return this.config.get();
  }

  getConfigService(): ConfigService {
    return this.config;
  }

  getBaseUrl() {
    if (this.baseUrl) {
      return this.baseUrl;
    }
    const config = this.getConfig();
    if (config && config.crowi && config.crowi['app:url']) {
      return config.crowi['app:url'];
    }

    // This might be happend when env BASE_URL is not set and this is not an express request.
    // While initialize express, config.crowi['app:url'] could be set be detecting accessing URL.
    return null;
  }

  getEnv() {
    return this.env;
  }

  buildRedisOpts(redisUrl: string | null, redisRejectUnauthorized: boolean) {
    if (redisUrl) {
      const { hostname: host, port, auth, protocol } = url.parse(redisUrl);
      const password = auth ? { password: auth.split(':')[1] } : {};

      // Convert port to number for Redis v4 compatibility
      const portNumber = port ? parseInt(port, 10) : 6379;

      const tls: object | null = protocol === 'rediss:' ? { requestCert: true, rejectUnauthorized: redisRejectUnauthorized } : null;

      // Redis v4 uses socket object for connection configuration
      const socketConfig = {
        host,
        port: portNumber,
        ...(tls && { tls }),
      };

      return {
        socket: socketConfig,
        ...password,
      };
    }

    return null;
  }

  // getter/setter of model instance
  //
  model<T extends keyof Models>(name: T, model?: Models[T]): Models[T] {
    if (model) {
      return (this.models[name] = model);
    }

    return this.models[name];
  }

  // getter/setter of event instance
  event<T extends keyof Events>(name: T, event?: Events[T]): Events[T] {
    if (event) {
      return (this.events[name] = event);
    }

    return this.events[name];
  }

  /**
   * Validate CROWI_ENCRYPTION_KEY at boot. When set, it must base64-decode to
   * exactly 32 bytes (AES-256). When unset we log a warning and let Config
   * fall back to plaintext at-rest storage — same behaviour as pre-encryption
   * deployments — so a missing key never blocks boot.
   */
  setupEncryption() {
    const raw = process.env.CROWI_ENCRYPTION_KEY;
    if (!raw) {
      console.warn('[crowi] CROWI_ENCRYPTION_KEY is not set — sensitive Config values will be stored as plaintext (legacy mode).');
      console.warn('[crowi] Generate a 32-byte key with: openssl rand -base64 32');
      return;
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(`Invalid CROWI_ENCRYPTION_KEY: expected 32 bytes after base64 decode, got ${buf.length}. Generate one with \`openssl rand -base64 32\`.`);
    }
    // Drop any cached key from a previous init in long-lived test processes.
    resetKeyProvider();
    debug('CROWI_ENCRYPTION_KEY is configured (sensitive Config values will be encrypted at rest)');
  }

  setupDatabase() {
    // mongoUri = mongodb://user:password@host/dbname
    mongoose.Promise = global.Promise;

    // Set strictQuery to true for schema consistency and query safety
    mongoose.set('strictQuery', true);

    const mongoUri =
      this.env.MONGOLAB_URI || // for B.C.
      this.env.MONGODB_URI || // MONGOLAB changes their env name
      this.env.MONGOHQ_URL ||
      this.env.MONGO_URI ||
      'mongodb://localhost/crowi';

    return new Promise((resolve, reject) => {
      const mongooseOptions = {
        // Mongoose 6+ removes these deprecated options
      };
      mongoose.connect(mongoUri, mongooseOptions, (e) => {
        if (e) {
          debug('DB Connect Error: ', e);
          debug('DB Connect Error: ', mongoUri);
          return reject(new Error("Cann't connect to Database Server."));
        }

        this.mongoose = mongoose;
        return resolve(mongoose);
      });
    });
  }

  async setupRedisClient() {
    if (this.redisOpts) {
      try {
        const redisClient = createClient(this.redisOpts);
        await redisClient.connect();
        this.redis = redisClient;
        debug('Redis client connected successfully');
      } catch (error) {
        debug('Failed to connect to Redis:', (error as Error).message);
        console.warn('Redis connection failed. Continuing without Redis...');
        this.redis = null;
      }
    }
  }

  setupSessionConfig() {
    const sessionAge = 1000 * 3600 * 24 * 30;
    const sessionConfig = {
      rolling: true,
      secret: this.env.SECRET_TOKEN || 'this is default session secret',
      resave: false,
      saveUninitialized: true,
      cookie: {
        httpOnly: true,
        maxAge: sessionAge,
      },
      store: undefined as any,
    };

    if (this.redis) {
      sessionConfig.store = new RedisStore({
        prefix: 'crowi:sess:',
        client: this.redis,
      });
    }

    this.sessionConfig = sessionConfig;
  }

  async setupModels() {
    const keys = Object.keys(models) as (keyof typeof models)[];
    keys.forEach((key) => {
      this.model(key, models[key](this));
    });
  }

  setupEvents() {
    return Object.entries(events).forEach(([key, Event]: any[]) => {
      this.event(key, new Event(this));
    });
  }

  getApp() {
    return this.app;
  }

  getMongo() {
    return this.mongoose;
  }

  getIo(): any {
    // return this.io
    return null;
  }

  getSearcher() {
    return this.searcher;
  }

  getMailer() {
    return this.mailer;
  }

  async setupConfig() {
    this.config = new ConfigService(this);
    await this.config.setupPubSub();

    return this.config.load();
  }

  async migrateConfig() {
    const Config = this.model('Config');

    return Config.migrate();
  }

  async setupSearcher() {
    const searcherUri = this.env.ELASTICSEARCH_URI || this.env.BONSAI_URL || null;

    /*
    if (searcherUri) {
      try {
        this.searcher = new Searcher(this, searcherUri)
        this.searcher.initialize()
      } catch (e) {
        debug('Error on setup searcher', e)
        this.searcher = null
      }
    }
      */
  }

  setupMailer() {
    this.mailer = mailer(this);
  }

  setupSlack() {
    const config = this.getConfig();

    if (!hasSlackConfig(config)) {
      this.slack = {};
    } else {
      this.slack = slack(this);
    }
  }

  async setupDNSCache() {
    /**
     * Enable dnscache
     * To prevent slow dns resolution in vm on linux.
     * In December 2018, linux kernel may have race in conntrack.
     * See: https://www.weave.works/blog/racy-conntrack-and-dns-lookup-timeouts
     */
    if (this.env.ENABLE_DNSCACHE !== 'true') return;

    dnscache({ enable: true });
  }

  setupLRU() {
    this.lru = new LRU(this);
  }

  getTokens() {
    return this.tokens;
  }

  start = () => {
    if (this.app === null) {
      throw new Error('Must call init() before start().');
    }

    const server = http.createServer(this.app).listen(this.port, () => {
      console.log('[' + this.node_env + '] Express server listening on port ' + this.port);
    });
    /*
    const io = socketIO(server, { transports: ['websocket'] })
    if (this.redisOpts) {
      io.adapter(socketIORedis(this.redisOpts))
      debug('Using socket.io-redis')
    }
    io.sockets.on('connection', (socket) => {
      debug('Websocket CONNECTED, socket.id:', socket.id)
    })

    this.io = io
    */

    return this.app;
  };

  buildServer() {
    const app = express();
    const env = this.node_env;

    this.middlewares = middlewares(this, app);
    this.controllers = controllers(this, app);

    expressInit(this, app);
    routes(this, app);

    if (env == 'development') {
      // swig.setDefaults({ cache: false });
      app.use(errorHandler({ dumpExceptions: true, showStack: true }));
      app.use(morgan('dev'));
    }

    if (env == 'production') {
      app.use(morgan('combined'));
      app.use(function (err, req, res, next) {
        res.status(500);
        res.json({ error: 'Internal Server Error', message: err.message });
      });
    }

    this.app = app;
    return app;
  }

  exitOnError(err) {
    debug('Critical error occured.');
    console.error(err);
    console.error(err.stack);
    process.exit(1);
  }
}

export default Crowi;
