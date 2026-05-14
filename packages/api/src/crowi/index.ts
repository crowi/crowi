import Debug from 'debug';
import path, { sep } from 'path';
import mongoose from 'mongoose';
import Tokens from 'csrf';
import { createClient } from 'redis';
import http from 'http';
import { buildRedisOpts } from 'src/util/redis-opts';
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
import { createPageEventPubSub, type PageEventPubSub } from '../service/page-event-pubsub';
import { hasSlackConfig } from '../models/config';
import mailer from 'src/util/mailer';
import slack from 'src/util/slack';
import { resetKeyProvider } from 'src/util/crypto';
import { PluginManager, type PluginRegistries } from 'src/plugin';
import { type Renderer, createRenderer } from 'src/renderer';
import { registerRenderCacheInvalidation } from 'src/events/render-cache';
import { registerMentionDispatch } from 'src/events/mention-dispatch';
import { runAwsConfigMigration } from 'src/util/aws-config-migration';
import expressInit from './express-init';

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

  tmpDir: string;

  cacheDir: string;

  app: any = null;

  mongoose: any = null;

  // FIXME after service/config typed
  config: any;

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

  /**
   * Markdown renderer pipeline + registry. Available after
   * `setupRenderer` runs in `init()` (between `setupModels` and
   * `setupPlugins` — so PluginManager can layer external plugins on
   * top of the core registrations).
   */
  renderer: Renderer | null = null;

  /**
   * Cross-process pageEvent fan-out (RFC-0003 Phase 5). Built after
   * `setupRenderer` so the api-side listeners (render-cache /
   * mention-dispatch) are already registered when remote `update`
   * events start arriving. `null` outside of `init()` (CLI mode boots
   * via `initForCli` and skips the pub/sub).
   */
  pageEventPubSub: PageEventPubSub | null = null;

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
    // Must run before setupPlugins — @crowi/plugin-aws reads its config at
    // register time. Idempotent (write-only-when-target-empty); a failure
    // here can leak plaintext secrets, so let it bubble out instead of
    // continuing boot.
    await runAwsConfigMigration(this);
    // Renderer must boot BEFORE plugins so PluginManager.activate()
    // can hand plugins a registry that already has the core 4
    // transforms (TOC / wikilinks / mentions / codeBlockLanguages)
    // registered. External plugins append; they cannot insert before
    // core in v2.1 phase 2.
    this.setupRenderer();
    // RFC-0003 Phase 5 — start the cross-process pageEvent subscriber
    // **after** `setupRenderer` (renders' invalidation listener +
    // mention-dispatch are wired in setupRenderer) so a remote
    // `update` message that arrives during boot still reaches them.
    // Plugins (next step) are not currently registering page listeners
    // (verified: grep `crowi.event('Page')` in packages/plugin-* = 0
    // hits at Phase 5 plan time), so booting pub/sub before
    // `setupPlugins` is safe. Move below `setupPlugins` if a future
    // plugin starts subscribing.
    await this.setupPageEventPubSub();
    // Plugins must boot AFTER config/models are ready (so PluginContext
    // can read config and access models) but BEFORE the legacy
    // mailer / slack initialisers — those are migrating to
    // plugin-provided drivers and any conflict should fail noisily here.
    await this.setupPlugins();
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
    this.setupRenderer();
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

  /**
   * RFC-0003 Phase 5 — build the cross-process pageEvent subscriber
   * and (when REDIS_URL is set) subscribe to `crowi:pageEvent:*`. A
   * single hop: the @crowi/collab process publishes after a checkpoint
   * save → this subscriber re-emits on the local `pageEvent('Page')`
   * EventEmitter → api listeners (render-cache / mention-dispatch /
   * search index) react as if the save had happened in-process.
   *
   * No-op + warn when Redis isn't configured (= single-instance dev
   * environment); explicit reset on each `init()` so long-lived test
   * processes (Crowi.reload) get a fresh subscriber.
   */
  async setupPageEventPubSub() {
    if (this.pageEventPubSub) {
      try {
        await this.pageEventPubSub.shutdown();
      } catch {
        // best-effort — boot path shouldn't be blocked by stale handle
      }
    }
    this.pageEventPubSub = createPageEventPubSub(this);
    await this.pageEventPubSub.setup();
  }

  setupRenderer() {
    this.renderer = createRenderer(this);
    // Register cache invalidation listeners on pageEvent. Needs to
    // happen here (not in setupEvents) because the listener captures
    // the renderer.cache handle constructed one line above.
    registerRenderCacheInvalidation(this);
    // RFC-0002 Phase 8: dispatch `@username` mention notifications on
    // page save. Wired here (not in `setupEvents`) because the dispatcher
    // reads `Revision.meta.mentions[]` produced by the renderer pipeline,
    // so it must register after `setupRenderer` has run.
    registerMentionDispatch(this);
    // Eagerly initialise heavy ESM-only deps (jiti + shiki +
    // remark-*). The first pipeline run otherwise pays ~200ms cold-
    // load latency; we move that cost to boot time. Fire-and-forget —
    // a warmup failure is logged inside `Renderer.warmup` and does
    // not block boot.
    if (this.renderer) {
      void this.renderer.warmup();
    }
  }

  /**
   * Markdown renderer (parse → transform pipeline + extension registry).
   * Throws if accessed before `setupRenderer` ran.
   */
  getRenderer(): Renderer {
    if (!this.renderer) {
      throw new Error('Renderer has not been booted yet — call init() first.');
    }
    return this.renderer;
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
    // Thin wrapper kept for back-compat with existing `crowi.buildRedisOpts`
    // callers; the actual translation lives in `util/redis-opts.ts` so
    // the collab process can pull the same helper through `api-dist.ts`.
    return buildRedisOpts(redisUrl, redisRejectUnauthorized);
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

  /**
   * Backwards-compat shim for legacy controllers that still reference
   * `crowi.getSearcher()`. Returns the active search driver from the
   * plugin registry, or `null` if none is configured / registered.
   * New code should read `crowi.getPlugins().active.search` directly.
   */
  getSearcher() {
    if (!this.pluginRegistries) return null;
    return this.pluginRegistries.active.search;
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
