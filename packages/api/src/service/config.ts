import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import Debug from 'debug';
import { createClient } from 'redis';
import Crowi from 'src/crowi';
import { formatPluginNamespace, parsePluginConfigKey } from 'src/plugin/plugin-namespace';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

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

  /**
   * Tail of the in-process config-write queue. Without it, a failing
   * write's reload-then-set can interleave with a different write's own
   * set() — whichever finishes last wins, even when it holds the older
   * snapshot. Public entry points chain onto this; nothing they call
   * internally may, or a turn already dequeued and running would wait on
   * itself and never resolve (see `serializeWrite`).
   */
  private writeQueueTail: Promise<unknown> = Promise.resolve();

  /**
   * Marks "the code currently running is part of an already-dequeued
   * write-queue turn" across the turn's whole async call chain — not just
   * `serializeWrite`'s own `task()` call, but anything that call in turn
   * awaits. Only a FAILURE-path turn keeps notifying inside this window
   * (reload, publish, the `'remote'`-tagged notify, and any reconfigure a
   * listener triggers in response — see `serializeWrite`'s doc for why).
   * A success-path turn's local notify runs after the queue has already
   * released (see `saveConfig` et al.), so it is never covered by this
   * marker. `serializeWrite` reads it to tell a genuinely-concurrent
   * caller (must wait its turn) apart from a reentrant call the
   * still-in-flight failure-path notify makes into itself, e.g. a
   * plugin's `reconfigure(ctx)` writing back via `ctx.setConfig()` while
   * the notification that triggered it is still running — that call must
   * run inline instead of enqueueing, or it would wait on the very turn
   * that is calling it.
   */
  private readonly writeContext = new AsyncLocalStorage<true>();

  constructor(crowi: Crowi) {
    this.crowi = crowi;
    // this config is a local memory cache
    this.config = {};
    this.configModel = this.crowi.model('Config');

    this.pubSub = {
      id: crypto.randomUUID(),
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
      await this.publishToRedis(changedNamespaces);
    }

    await this.postUpdate(changedNamespaces, source);
  }

  private async publishToRedis(changedNamespaces: string[]): Promise<void> {
    const { publisher, channel, id } = this.pubSub;
    if (!publisher) return;
    try {
      const payload: PubSubPayload = { id, changedNamespaces };
      await publisher.publish(channel, JSON.stringify(payload));
    } catch (error) {
      debug('Failed to publish config update:', (error as Error).message);
    }
  }

  /**
   * Runs `task` after every previously-queued write's turn has finished.
   * `task` itself decides how much of the write is covered: a FAILURE
   * path (see `saveConfig`) keeps its whole post-write notification
   * (reload, publish, `postUpdate`, and anything a listener does in
   * response, e.g. a plugin's `reconfigure(ctx)`) inside `task`, so a
   * slow reconfigure genuinely blocks the next config write from
   * starting — closing the ordering gap a shorter "release the queue
   * right after the Mongo write" turn would leave (two turns'
   * notifications could otherwise finish in either order, and the
   * later-finishing one's driver reconfiguration would win regardless of
   * which one actually holds the newer config). A SUCCESS path's `task`
   * covers only the write and the local memory update — its local notify
   * runs after this method already returned, deliberately outside the
   * queue (see `saveConfig`'s doc).
   *
   * Covering more of a turn inside `task` requires telling apart two
   * calls that can both arrive while that turn is in flight: a genuinely
   * concurrent OTHER caller (must queue and wait, same as ever) and a
   * REENTRANT call the in-flight turn makes into itself (e.g. a
   * config-change listener notified from inside a failure-path turn
   * calling `ctx.setConfig()` → `saveConfigValue`, which is a public
   * entry point too). Queueing the reentrant case would make it wait on
   * the very turn that is calling it — a guaranteed deadlock. The two are
   * indistinguishable by any state visible at the call site (both see "a
   * turn is currently running"); only the actual JS call stack tells them
   * apart, which is exactly what `writeContext` (`AsyncLocalStorage`)
   * captures: it stays set for every continuation of the turn's own async
   * chain, and is absent for an unrelated caller — including a listener
   * reacting to a SUCCESS path's local notify, since that notify runs
   * after `writeContext.run()` has already returned.
   */
  private serializeWrite<T>(task: () => Promise<T>): Promise<T> {
    if (this.writeContext.getStore()) {
      // Already inside this turn's own call chain — run inline. See the
      // class doc above.
      return task();
    }
    const runTurn = () => this.writeContext.run(true, task);
    const turn = this.writeQueueTail.then(runTurn, runTurn);
    // The tail only needs to know "the previous turn is done", never its
    // outcome — swallowing here keeps one failed turn from poisoning the
    // wait for the next caller, who still observes the real result via
    // `turn`.
    this.writeQueueTail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async postUpdate(changedNamespaces: string[] = [], source: ConfigChangeSource = 'local') {
    debug('Config updated run postUpdate');
    await this.crowi.setupMailer();
    await this.notifyListeners(changedNamespaces, source);
  }

  /**
   * Persists every key of `config` to `ns`, then (and ONLY then) updates
   * local memory, notifies change listeners, and publishes to Redis. The
   * write itself always runs inside one `serializeWrite` turn, but how
   * much of the notification joins that turn depends on the outcome:
   *
   * - On SUCCESS, the turn covers only the write and the local memory
   *   update; it returns the changed namespaces and this method notifies
   *   (`notifyUpdated(changed, 'local')`) AFTER the turn — and the write
   *   queue — has already released. That keeps a plain successful save
   *   exactly as unserialized as it was before this queue existed (design
   *   decision 3: the success path is otherwise unchanged), so a listener
   *   reacting to this notify and calling back into a public entry point
   *   (`saveConfigValue` etc.) is an ordinary new queued call, never a
   *   reentrant one — no `AsyncLocalStorage` marker is active by then.
   * - On FAILURE, the turn covers the reload, the publish, and the
   *   `'remote'`-tagged notify (and whatever a listener does in response,
   *   e.g. a plugin's `reconfigure(ctx)`) too — see `serializeWrite`'s doc
   *   for why keeping the notify inside the turn (rather than releasing
   *   the queue early) matters here: a later config write cannot start,
   *   and a later write's own reconfigure cannot race this one's, until
   *   this turn's notification has fully finished. A reentrant call this
   *   notification triggers (a listener writing back via
   *   `ctx.setConfig()`) safely runs inline instead of queueing behind
   *   itself — see `serializeWrite`'s doc — which also means that
   *   reentrant write's OWN trailing local notify still runs inside the
   *   outer failure turn (it has no queue release of its own to wait
   *   for); that's an accepted, unavoidable side effect of not deadlocking
   *   AC-7, not a missed case of the success/failure split above.
   *
   * `configModel.updateConfigByNamespace` writes each key independently
   * (`Promise.allSettled` — see its own doc), so a rejection here can
   * still leave some keys persisted: the write is not atomic across keys.
   * On that rejection, before rethrowing, this reloads from Mongo
   * (`this.load()`) so local memory reflects exactly what landed, then
   * publishes and notifies tagged `'remote'` rather than `'local'`.
   * That's deliberate: the caller is about to see this rejection and
   * return an error response without ever calling `reconfigureAffected`
   * itself, so nothing else will reconfigure this replica — tagging the
   * notification `'remote'` makes `PluginManager.handleConfigChange`
   * treat it exactly like a change received over pub/sub from another
   * replica and reconfigure right here, instead of assuming (as it does
   * for a genuine local success) that the caller already handled it.
   *
   * If the reload itself fails (typically because Mongo is generally
   * unavailable at that point, not just for this one write), memory is
   * left as-is, nothing is published or notified, and only the original
   * write error propagates — the reload failure is logged, never thrown,
   * so it can't mask the write failure the caller needs to see. The same
   * holds if publish/notify itself throws after a successful reload.
   */
  async saveConfig(ns: string, config: Record<string, any>): Promise<void> {
    const changed = await this.serializeWrite(() => this.saveConfigTurn(ns, config));
    await this.notifyUpdated(changed, 'local');
  }

  private async saveConfigTurn(ns: string, config: Record<string, unknown>): Promise<string[]> {
    debug('Save config', ns, config);
    const changed = deriveChangedNamespaces(ns, Object.keys(config));

    try {
      await this.configModel.updateConfigByNamespace(ns, config);
    } catch (writeErr) {
      try {
        await this.load();
        try {
          await this.publishToRedis(changed);
          await this.postUpdate(changed, 'remote');
        } catch (notifyErr) {
          debug('Failed to notify after a config write failure:', (notifyErr as Error).message);
        }
      } catch (reloadErr) {
        debug('Failed to reconcile config after a write failure:', (reloadErr as Error).message);
      }
      throw writeErr;
    }

    this.set({ ...this.config, [ns]: { ...this.config[ns], ...config } });
    return changed;
  }

  /**
   * Single-key counterpart of `saveConfig` — same fail-propagating
   * contract, and the same success/failure split of what runs inside the
   * write-queue turn (see `saveConfig`'s doc): `configModel.updateConfig`
   * no longer swallows a Mongo failure, so a rejection reaches the caller
   * before `applyLocalValueUpdate` (the in-memory mutation) ever runs, and
   * on success the listener notify + Redis publish happen after the queue
   * has already released this turn.
   */
  async saveConfigValue(ns: string, key: string, value: any) {
    const changed = await this.serializeWrite(() => this.saveConfigValueTurn(ns, key, value));
    await this.notifyUpdated(changed, 'local');
  }

  private async saveConfigValueTurn(ns: string, key: string, value: unknown): Promise<string[]> {
    debug('Save config value', ns, key, value);
    await this.configModel.updateConfig(ns, key, value);
    return this.applyLocalValueUpdate(ns, key, value);
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
   * The flat fields are applied to local memory together, in one `set`,
   * so a listener never sees the group half-applied either. As with
   * `saveConfig`, that notify runs after the queue has already released
   * this turn (see `saveConfig`'s doc for the success/failure split).
   */
  async saveConfigAtomicGroup(ns: string, pluginName: string, groupName: string, values: Record<string, string>) {
    const changed = await this.serializeWrite(() => this.saveConfigAtomicGroupTurn(ns, pluginName, groupName, values));
    await this.notifyUpdated(changed, 'local');
  }

  private async saveConfigAtomicGroupTurn(ns: string, pluginName: string, groupName: string, values: Record<string, string>): Promise<string[]> {
    debug('Save atomic config group', ns, pluginName, groupName, Object.keys(values));
    await this.configModel.updateAtomicConfigGroup(ns, pluginName, groupName, values);

    const flat: Record<string, string> = {};
    for (const [field, value] of Object.entries(values)) {
      flat[`plugin:${pluginName}:${field}`] = value;
    }
    // One namespace, notified once — the group is a single logical change
    // however many fields it happens to contain.
    this.set({ ...this.config, [ns]: { ...this.config[ns], ...flat } });
    return [`plugin:${pluginName}`];
  }

  /** Shared local-memory mutation of `saveConfigValue`'s write queue turn — no notify here; the caller notifies after the turn releases (see `saveConfig`'s doc). */
  private applyLocalValueUpdate(ns: string, key: string, value: any): string[] {
    const changed = deriveChangedNamespaces(ns, [key]);
    this.set({ ...this.config, [ns]: { ...this.config[ns], [key]: value } });
    return changed;
  }

  async deleteConfig(ns: string, key: string) {
    const changed = await this.serializeWrite(() => this.deleteConfigTurn(ns, key));
    await this.notifyUpdated(changed, 'local');
  }

  private async deleteConfigTurn(ns: string, key: string): Promise<string[]> {
    await this.configModel.deleteConfig(ns, key);
    delete this.config[ns][key];
    return deriveChangedNamespaces(ns, [key]);
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
