import Debug from 'debug';
import { createClient } from 'redis';
import Crowi from 'src/crowi';
import { formatPluginNamespace, parsePluginConfigKey } from 'src/plugin/plugin-namespace';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';
import { v4 } from 'uuid';

const debug = Debug('crowi:service:config');

export type ConfigChangeSource = 'local' | 'remote';
export type ConfigChangeListener = (changedNamespaces: string[], source: ConfigChangeSource) => void | Promise<void>;

interface PubSubPayload {
  id: string;
  changedNamespaces?: string[];
}

export default class ConfigService {
  crowi: Crowi;

  config: any;

  configModel: any;

  pubSub: {
    id: string;
    publisher: any;
    subscriber: any;
    channel: string;
  };

  private listeners: ConfigChangeListener[] = [];

  constructor(crowi: Crowi) {
    this.crowi = crowi;
    // this config is a local memory cache
    this.config = {};
    this.configModel = this.crowi.model('Config');

    this.pubSub = {
      id: v4(),
      publisher: null,
      subscriber: null,
      // Placeholder — never actually published/subscribed on before
      // `setupPubSub()` re-resolves this to the instance-scoped
      // `crowi:<slug>:config` channel (feature-redis-key-prefix §1/§2).
      channel: 'config',
    };

    // setupPubSub will be called from Crowi.setupConfig()
  }

  async load() {
    const Config = this.crowi.model('Config');
    const config = await Config.loadAllConfig();
    this.set(config);
  }

  set(config) {
    // FIXME: Deep copy to avoid deleting itself.
    const newConfig = { ...config };
    // FIXME: Treat as a mutable object always.
    //        We should always get config using `crowi.getConfig()` *just before* referencing config.
    for (const key of Object.keys(this.config)) {
      delete this.config[key];
    }
    for (const key of Object.keys(newConfig)) {
      this.config[key] = newConfig[key];
    }
  }

  get(ns?: string, key?: string) {
    if (ns && key) {
      if (!this.config[ns]) {
        throw new Error(`No such namespace in config: ${ns}`);
      }

      return this.config[ns][key];
    }

    return this.config || {};
  }

  /**
   * Subscribe to config changes. Listeners receive the list of
   * namespaces that contained at least one changed key. Listeners run
   * sequentially and `saveConfig` awaits them, so admin UI responses
   * reflect "all consumers have applied the change". Returns a
   * disposer so long-lived processes (HMR / Crowi.reload) can detach.
   */
  onConfigChange(listener: ConfigChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private async notifyListeners(changedNamespaces: string[], source: ConfigChangeSource): Promise<void> {
    if (this.listeners.length === 0) return;
    for (const listener of this.listeners) {
      try {
        await listener(changedNamespaces, source);
      } catch (err) {
        debug('config change listener threw:', (err as Error).message);
      }
    }
  }

  async notifyUpdated(changedNamespaces: string[] = [], source: ConfigChangeSource = 'local') {
    // To notify config updated to another srever, publish event via pubsub.
    if (source === 'local') {
      const { publisher, channel, id } = this.pubSub;
      if (publisher) {
        try {
          const payload: PubSubPayload = { id, changedNamespaces };
          await publisher.publish(channel, JSON.stringify(payload));
        } catch (error) {
          debug('Failed to publish config update:', (error as Error).message);
        }
      }
    }

    await this.postUpdate(changedNamespaces, source);
  }

  async postUpdate(changedNamespaces: string[] = [], source: ConfigChangeSource = 'local') {
    debug('Config updated run postUpdate');
    await this.crowi.setupMailer();
    await this.notifyListeners(changedNamespaces, source);
  }

  /**
   * Persists every key of `config` to `ns`, then (and ONLY then) updates
   * local memory, notifies change listeners, and publishes to Redis.
   *
   * `configModel.updateConfigByNamespace` writes each key independently
   * (`Promise.allSettled` — see its own doc), so a rejection here can
   * still leave some keys persisted: the write is not atomic across keys.
   * On that rejection, before rethrowing, this reloads from Mongo
   * (`this.load()`) so local memory reflects exactly what landed, tells
   * local listeners, and republishes using the namespaces the attempted
   * batch touched so other replicas reload too. That keeps "in-memory
   * config matches what Mongo holds" true even on partial failure,
   * without requiring the caller to resend the same payload to converge.
   *
   * If the reload itself fails (typically because Mongo is generally
   * unavailable at that point, not just for this one write), memory is
   * left as-is and only the original write error propagates — the
   * reload failure is logged, never thrown, so it can't mask the write
   * failure the caller needs to see.
   */
  async saveConfig(ns: string, config: Record<string, any>) {
    debug('Save config', ns, config);
    const changed = deriveChangedNamespaces(ns, Object.keys(config));

    try {
      await this.configModel.updateConfigByNamespace(ns, config);
    } catch (writeErr) {
      try {
        await this.load();
        await this.notifyUpdated(changed, 'local');
      } catch (reconcileErr) {
        debug('Failed to reconcile config after a write failure:', (reconcileErr as Error).message);
      }
      throw writeErr;
    }

    await this.update({ ...this.config, [ns]: { ...this.config[ns], ...config } }, changed);
  }

  /**
   * Single-key counterpart of `saveConfig` — same fail-propagating
   * contract. `configModel.updateConfig` no longer swallows a Mongo
   * failure, so a rejection reaches the caller before
   * `applyLocalValueUpdate` (in-memory mutation + listener notify + Redis
   * publish) ever runs.
   */
  async saveConfigValue(ns: string, key: string, value: any) {
    debug('Save config value', ns, key, value);
    await this.configModel.updateConfig(ns, key, value);
    await this.applyLocalValueUpdate(ns, key, value);
  }

  /**
   * RFC-0014 phase 4 — persist one atomic plugin config group, then (and
   * ONLY then) make it visible anywhere else.
   *
   * The ordering is the entire contract. `updateAtomicConfigGroup` throws
   * on failure and that throw is propagated untouched, so a rejected write
   * leaves the in-memory config, the change listeners and the Redis
   * publish all untouched — no replica, local or remote, can observe a
   * value the database does not hold. Because the group is a single
   * document, there is also no partial write to clean up: the previous
   * complete group simply remains.
   *
   * The flat fields are applied to local memory together, in one `update`,
   * so a listener never sees the group half-applied either.
   */
  async saveConfigAtomicGroup(ns: string, pluginName: string, groupName: string, values: Record<string, string>) {
    debug('Save atomic config group', ns, pluginName, groupName, Object.keys(values));
    await this.configModel.updateAtomicConfigGroup(ns, pluginName, groupName, values);

    const flat: Record<string, string> = {};
    for (const [field, value] of Object.entries(values)) {
      flat[`plugin:${pluginName}:${field}`] = value;
    }
    // One namespace, notified once — the group is a single logical change
    // however many fields it happens to contain.
    await this.update({ ...this.config, [ns]: { ...this.config[ns], ...flat } }, [`plugin:${pluginName}`]);
  }

  /** Shared local-memory-update + notify tail of `saveConfigValue`, run only after the write it follows has already succeeded. */
  private async applyLocalValueUpdate(ns: string, key: string, value: any) {
    const changed = deriveChangedNamespaces(ns, [key]);
    await this.update({ ...this.config, [ns]: { ...this.config[ns], [key]: value } }, changed);
  }

  async deleteConfig(ns: string, key: string) {
    await this.configModel.deleteConfig(ns, key);
    delete this.config[ns][key];
    const changed = deriveChangedNamespaces(ns, [key]);
    await this.update(this.config, changed);
  }

  /**
   * To update the property of ConfigService,
   * the config serice user (e.g. some controller, model, etc.) must call this update() method.
   * Otherwise,
   *  - the config memory cache would not be refreshed,
   *  - the service like Slack, Mailer etc. would not be reloaded,
   *  - the other server (in multi-server structure) would not be notified the config updated.
   */
  async update(config, changedNamespaces: string[] = [], source: ConfigChangeSource = 'local') {
    this.set(config);
    await this.notifyUpdated(changedNamespaces, source);
  }

  async setupPubSub() {
    const { redisOpts, redis } = this.crowi;

    // Gate on the ESTABLISHED boot connection (`crowi.redis`), not just on
    // Redis being configured: when `setupRedisClient` degraded (server
    // unreachable), connecting two more clients here would hit the same
    // unbounded retry loop and hang boot.
    if (redisOpts && redis) {
      // Instance-scoped (feature-redis-key-prefix §1/§2) — resolved once,
      // here, replacing the constructor's placeholder `'config'` literal.
      // `resolveRedisKeyspace` (not the `-IfEnabled` variant) is
      // appropriate: this branch only runs once Redis is actually in
      // play, at which point a keyspace is always resolvable (env
      // validation guarantees it at boot), so there is no legitimate
      // "Redis enabled but no keyspace" case to degrade for here.
      this.pubSub.channel = resolveRedisKeyspace(this.crowi).key('config');
      try {
        this.pubSub.publisher = createClient(redisOpts);
        this.pubSub.subscriber = createClient(redisOpts);
        // Without an 'error' listener, a steady-state Redis outage after
        // these clients connect raises an unhandled EventEmitter 'error'
        // and crashes the process.
        this.pubSub.publisher.on('error', (err: Error) => debug('config pub/sub publisher error:', err.message));
        this.pubSub.subscriber.on('error', (err: Error) => debug('config pub/sub subscriber error:', err.message));

        await this.pubSub.publisher.connect();
        await this.pubSub.subscriber.connect();

        const { pubSub } = this;
        const { subscriber } = pubSub;

        debug('PubSubId', pubSub.id);

        if (subscriber) {
          // @redis/client v4 takes the message listener as the 2nd argument
          // to `subscribe`. The v3 `.on('message', ...)` pattern leaves no
          // listener registered, so when a message arrives the client tries
          // to invoke `undefined` and crashes the process with
          // "TypeError: listener is not a function".
          await subscriber.subscribe(pubSub.channel, async (message: string, channel: string) => {
            if (channel !== pubSub.channel) return;

            const payload = JSON.parse(message) as PubSubPayload;
            if (payload.id === pubSub.id) return;

            await this.load();
            // Older publishers won't include `changedNamespaces`; treat
            // that as "everything changed" so subscribers default to a
            // safe fan-out instead of skipping reconfigure entirely.
            const changedNamespaces = payload.changedNamespaces ?? ['*'];
            await this.postUpdate(changedNamespaces, 'remote');

            debug(`Config updated by ${payload.id}`);
          });
        }

        debug('Redis pub/sub setup completed');
      } catch (error) {
        debug('Failed to setup Redis pub/sub:', (error as Error).message);
        console.warn('Redis pub/sub setup failed. Config synchronization disabled.');
        this.pubSub.publisher = null;
        this.pubSub.subscriber = null;
      }
    }
  }
}

/**
 * Plugin configs all live under the `crowi` mongo namespace as
 * `plugin:<name>:<field>` keys, but listeners want "plugin X changed",
 * not "the kitchen-sink `crowi` ns changed". Split here so listeners
 * stay simple.
 */
export function deriveChangedNamespaces(mongoNs: string, keys: string[]): string[] {
  const out = new Set<string>();
  let sawNonPluginKey = false;
  for (const key of keys) {
    const parsed = parsePluginConfigKey(key);
    if (parsed) {
      out.add(formatPluginNamespace(parsed.pluginName));
    } else {
      sawNonPluginKey = true;
    }
  }
  if (sawNonPluginKey || keys.length === 0) {
    out.add(mongoNs);
  }
  return [...out];
}
