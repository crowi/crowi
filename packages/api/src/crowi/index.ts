import Debug from 'debug';
import path, { sep } from 'path';
import mongoose from 'mongoose';
import Tokens from 'csrf';
import { createClient } from 'redis';
import http from 'http';
import { buildRedisOpts } from 'src/util/redis-opts';
import models from 'src/models';
import events from 'src/events';
import { attachCollabServer, type AttachedCollab } from 'src/collab/attach';
import { attachPresenceServer, type AttachedPresence } from 'src/presence/attach';
import { createAdaptorServer } from '@hono/node-server';
import { buildHonoApp } from 'src/hono';
import { stripApiV2Prefix } from 'src/hono/path-rewrite';
import LRU from '../service/lru';
import ConfigService from '../service/config';
import { hasSlackConfig } from '../models/config';
import mailer from 'src/util/mailer';
import slack from 'src/util/slack';
import { resetKeyProvider } from 'src/util/crypto';
import { PluginManager, type PluginRegistries } from 'src/plugin';
import { type Renderer, createRenderer } from 'src/renderer';
import { registerRenderCacheInvalidation } from 'src/events/render-cache';
import { registerMentionDispatch } from 'src/events/mention-dispatch';
import { runAwsConfigMigration } from 'src/util/aws-config-migration';
import { runPageStatusMigration } from 'src/util/page-status-migration';

const pkg = require('../../package.json');

type Models = { [K in keyof typeof models]: ReturnType<(typeof models)[K]> };

type Events = { [K in keyof typeof events]: InstanceType<(typeof events)[K]> };

const debug = Debug('crowi:crowi');

class Crowi {
  version: string;

  rootDir: string;

  pluginDir: string;

  publicDir: string;

  resourceDir: string;

  tmpDir: string;

  cacheDir: string;

  mongoose: any = null;

  // FIXME after service/config typed
  config: any;

  mailer: any = {};

  lru: any = {};

  tokens: Tokens;

  // FIXME: {} をアサインしないで済む方法を捜す
  models: Models = {} as any as Models;

  events: Events = {} as any as Events;

  env: typeof process.env;

  baseUrl: string | null = null;

  node_env: string;

  port: number;

  redis: any = null;

  redisUrl: string | null;

  redisOpts: any;

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
   * Hocuspocus engine attach handle (RFC-0003 Phase 9 same-process).
   * Built lazily in `start()` after the http.Server is listening so
   * the `'upgrade'` event can be wired before any client connects.
   * `null` outside of the running server (= `init()` finished but
   * `start()` hasn't run yet, or after `shutdown()`).
   */
  collabAttachment: AttachedCollab | null = null;

  /**
   * Presence WebSocket attach handle (RFC-0005). Built in `start()`
   * alongside `collabAttachment`; wires the `/presence` ws noServer
   * handler so page viewers get the live-presence row. `null` outside
   * of the running server.
   */
  presenceAttachment: AttachedPresence | null = null;

  initialized = false;

  constructor(rootdir: string, env: typeof process.env) {
    this.version = pkg.version;

    this.env = env;
    this.baseUrl = this.env.BASE_URL || null;
    this.node_env = this.env.NODE_ENV || 'production';
    this.port = this.env.PORT ? Number.parseInt(this.env.PORT) : 4301;
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
    await this.setupConfig();
    await this.migrateConfig();
    // Must run before setupPlugins — @crowi/plugin-aws reads its config at
    // register time. Idempotent (write-only-when-target-empty); a failure
    // here can leak plaintext secrets, so let it bubble out instead of
    // continuing boot.
    await runAwsConfigMigration(this);
    // RFC-0004: backfill `status='published'` on legacy pages that
    // predate the `Page.status` field. Idempotent — only matches rows
    // where `status` is still null/missing. Runs after setupModels so
    // the Page model is available; ordering vs the aws migration is
    // irrelevant (disjoint collections).
    await runPageStatusMigration(this);
    // Renderer must boot BEFORE plugins so PluginManager.activate()
    // can hand plugins a registry that already has the core 4
    // transforms (TOC / wikilinks / mentions / codeBlockLanguages)
    // registered. External plugins append; they cannot insert before
    // core in v2.1 phase 2.
    this.setupRenderer();
    // RFC-0003 Phase 9 (same-process attach): the cross-process
    // pageEvent subscriber that used to fan collab saves into the
    // api event loop is gone — the embedded Hocuspocus engine (see
    // `src/collab/attach.ts`) calls `crowi.event('Page').emit(...)`
    // directly after a save flow completes.
    // Plugins must boot AFTER config/models are ready (so PluginContext
    // can read config and access models) but BEFORE the legacy
    // mailer / slack initialisers — those are migrating to
    // plugin-provided drivers and any conflict should fail noisily here.
    await this.setupPlugins();
    await this.setupMailer();
    await this.setupSlack();
    await this.setupLRU();

    this.initialized = true;
  }

  /**
   * Lightweight init for the `@crowi/admin-cli` operator CLI. Brings up
   * just what's needed to read Config + reach storage drivers — Redis
   * / mailer / slack / search / LRU / the boot-time AWS migration are
   * all skipped (the migration belongs to `init()` so the long-running
   * server runs it once; the CLI shouldn't mutate Mongo as a side
   * effect of starting up).
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

  setupLRU() {
    this.lru = new LRU(this);
  }

  getTokens() {
    return this.tokens;
  }

  start = async (): Promise<http.Server> => {
    if (!this.initialized) {
      throw new Error('Must call init() before start().');
    }

    // RFC-0006 Phase 6 Sub-batch D — Hono is the sole HTTP host.
    //
    // `buildHonoApp(crowi)` returns the `/api/v2/*` route surface.
    // Routes are registered at their un-prefixed paths
    // (`/app/info`, `/pages/:id`, ...) to keep the inferred AppType
    // chain shallow for the `hc<AppType>` client; the `/api/v2`
    // prefix is stripped by `stripApiV2Prefix` on the boundary so
    // production URLs match.
    //
    // We use `createAdaptorServer` instead of `serve` so the
    // WebSocket `'upgrade'` handlers (collab / presence) can be
    // wired **before** `server.listen()` runs — the upstream
    // `serve()` helper listens immediately, which would race the
    // first WS client against the upgrade hook.
    const honoApp = buildHonoApp(this);
    const fetchFn = (request: Request): Response | Promise<Response> => honoApp.fetch(stripApiV2Prefix(request));

    const server = createAdaptorServer({
      fetch: fetchFn,
      createServer: http.createServer,
      port: this.port,
    });

    // RFC-0003 Phase 9 — attach Hocuspocus to the http.Server
    // **before** `listen()` so the `'upgrade'` event handler is wired
    // when the first WebSocket client races the listen callback. The
    // attach is async because it builds the editor-cap counter
    // (Redis SCARD round-trip when configured); we await it here so
    // the boot sequence stays serial and `start()` resolves only
    // when the api is fully ready to accept WebSocket upgrades.
    this.collabAttachment = await attachCollabServer(server as http.Server, this);

    // RFC-0005 — attach the `/presence` WebSocket alongside `/collab`.
    // Same `noServer` pattern; both upgrade handlers path-filter so
    // they coexist on the one http.Server listener.
    this.presenceAttachment = await attachPresenceServer(server as http.Server, this);

    // Promisify `server.listen` so `start()` resolves only after the
    // socket is actually bound. Callers (the bin entry, smoke tests)
    // can then `await crowi.start()` and assume the api accepts
    // connections — without this the previous async chain returned
    // before listen() finished its background bind.
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        rejectListen(err);
      };
      const onListening = () => {
        server.off('error', onError);
        console.log('[' + this.node_env + '] Hono server listening on port ' + this.port);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port);
    });

    return server as http.Server;
  };

  exitOnError(err) {
    debug('Critical error occured.');
    console.error(err);
    console.error(err.stack);
    process.exit(1);
  }
}

export default Crowi;
