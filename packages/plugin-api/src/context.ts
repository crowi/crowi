/**
 * The context object passed to every plugin callback. It is the only
 * conduit through which a plugin reads core state (config, models,
 * logging) — plugins must NOT import from `@crowi/server` directly to
 * keep the contract surface thin.
 *
 * Trust boundary: a plugin only reaches what it explicitly declares.
 * `model(name)` is gated by the plugin's own `CrowiPlugin.modelAccess`
 * allow-list (see `model()` below) — there is no ambient "any core
 * model" access. There is intentionally no symmetric encrypt/decrypt
 * capability on this context: the only legitimate secret-reading path
 * is `config<T>()`, which already hands back `@sensitive` fields
 * transparently decrypted. A plugin cannot reach another plugin's or
 * core's secrets through `PluginContext`.
 */
export interface PluginContext {
  /**
   * Read this plugin's typed config. The runtime parses
   * `plugin:<plugin-name>:*` rows from the Mongo Config collection
   * through the plugin's `configSchema` and returns the result.
   *
   * Throws if `configSchema` is not declared on the plugin.
   */
  config<T>(): T;

  /**
   * Read a typed dependency plugin's config. The target plugin must
   * be listed in this plugin's `requires` array — reading another
   * plugin's config without declaring the dependency is a contract
   * violation and throws.
   *
   * Useful for shared-credential plugins like `@crowi/plugin-aws`:
   * the base plugin owns `region` / `accessKeyId` / `secretAccessKey`,
   * and dependents (`@crowi/plugin-storage-aws-s3`,
   * `@crowi/plugin-mail-aws-ses`) read them through this method
   * instead of duplicating the fields in their own configSchema.
   */
  dependencyConfig<T>(dependencyName: string): T;

  /**
   * Read core application info (the wiki name, …) — settings that live
   * outside this plugin's own config namespace but that an integration
   * may need (e.g. to brand an outbound manifest). Read live at call
   * time, so it reflects admin edits made after boot.
   */
  appInfo(): AppInfo;

  /** Write a single config field, persisting to Mongo. */
  setConfig(key: string, value: unknown): Promise<void>;

  /** Per-Page metadata accessor for this plugin's namespace. */
  pageMetadata: PageMetadataAccessor;

  /**
   * Mongoose model accessor, gated by this plugin's declared
   * `CrowiPlugin.modelAccess` allow-list. Plugins touch core
   * collections (Page, User, Comment, ...) through this accessor
   * rather than importing model files directly.
   *
   * Throws when `name` is not listed in the plugin's `modelAccess` —
   * a plugin must declare every core model it touches. A model name
   * listed in `modelAccess` is returned with full (unrestricted)
   * read/write access; there is no read-only proxying.
   *
   * Typed loosely (`unknown`) at this layer because the core model
   * types live in `@crowi/server`; plugins narrow the return type at
   * the call site.
   */
  model(name: string): unknown;

  /** Structured logger scoped to this plugin (auto-prefixed with name). */
  log: PluginLogger;

  /**
   * Hot-reload state primitive. Returns a {@link StateCell} that holds a
   * mutable value — the driver-owned resource (an S3 client, an SMTP
   * transport, a search client, ...) that `reconfigure` rebuilds when
   * admin saves new config. Every call across every `PluginContext`
   * instance for this plugin (the activation-time `ctx` passed to
   * `registerStorage`/`registerSearch`/`registerMailSender` etc., and
   * every later `reconfigure(ctx)` call) returns the **same** cell — the
   * runtime keys it by plugin name, not by `ctx` instance. `initial` is
   * only used the first time this plugin ever calls `state()`; later
   * calls ignore it and just return the existing cell.
   *
   * Use this instead of a module-scope `let`/`const` — it protects
   * in-flight `withValue()` callers from a concurrent `set()` swapping
   * the value out from under them, and gives `set()`'s `dispose` option
   * a correct place to tear down the previous value (close a client,
   * end a connection pool, ...) once nothing is still using it.
   */
  state<T>(initial: T): StateCell<T>;
}

/**
 * A hot-reload-safe mutable cell, returned by `PluginContext.state()`.
 * Designed for driver plugins (storage / search / mail / ...) that
 * `reconfigure()` rebuilds a stateful resource for: `withValue()` marks
 * the current value "in use" for the duration of the callback so a
 * concurrent `set()` cannot tear it down mid-call, and `set()`'s
 * `dispose` option only runs once every such in-flight caller has
 * settled.
 */
export interface StateCell<T> {
  /**
   * Atomic snapshot of the current value. Safe to read once and reuse
   * across `await`s in the caller — but prefer {@link withValue} when the
   * value may be disposed (e.g. an SDK client that `dispose` closes),
   * since `get()` gives no in-flight protection.
   */
  get(): T;

  /**
   * Run `fn` against the current value while marking it "in use", so a
   * concurrent `set()`'s `dispose` waits for `fn` to settle (resolve or
   * reject) before tearing down the value `fn` captured. This is the
   * primary way driver methods should read the cell.
   */
  withValue<R>(fn: (value: T) => R | Promise<R>): Promise<R>;

  /**
   * Swap in `next`. If `opts.dispose` is given, it runs — asynchronously,
   * never inline — once every `withValue()` call that was in flight
   * against the previous value at the moment of the swap has settled
   * (immediately, on the next microtask, if none were in flight).
   *
   * `dispose` must handle (and log, if relevant) its own errors — a
   * rejected `dispose` is swallowed by the runtime rather than
   * surfaced anywhere, since there is no caller left waiting on it by
   * the time it runs. Wrap the teardown in its own `try`/`catch` (or
   * `.catch()`) instead of letting it throw.
   */
  set(next: T, opts?: { dispose?: (prev: T) => void | Promise<void> }): void;
}

/**
 * Read-only view of core application settings exposed to plugins via
 * `ctx.appInfo()`. Intentionally a small, curated surface (not a generic
 * "read any core config" escape hatch) — add fields here as concrete
 * plugin needs appear.
 */
export interface AppInfo {
  /**
   * The configured wiki name (core `app:title`), trimmed. Always a
   * non-empty string: when the operator has not set a custom title it
   * defaults to `'Crowi'` (the seed value), so consumers never have to
   * handle an absent name.
   */
  title: string;

  /**
   * The wiki's public base origin (core `CLIENT_URL` / `getBaseUrl()`),
   * e.g. `https://wiki.example.com`. An **empty string** when no public
   * origin is configured — unlike `title` there is no sensible default,
   * so a plugin that needs an absolute URL (outbound webhook / manifest)
   * must handle the empty case. Plugins read this instead of
   * `process.env.CLIENT_URL` directly.
   */
  baseUrl: string;
}

/**
 * Per-Page metadata read / write helper. Each plugin gets a private
 * namespace at `page.metadata['<plugin-name>']`; this accessor scopes
 * reads and writes to just that slot so plugins cannot accidentally
 * trample on each other.
 */
export interface PageMetadataAccessor {
  /** Read this plugin's metadata for a specific page. Returns null when unset. */
  get<T>(pageId: string): Promise<T | null>;
  /** Replace this plugin's metadata for a specific page. */
  set<T>(pageId: string, value: T): Promise<void>;
  /** Remove this plugin's metadata for a specific page. */
  remove(pageId: string): Promise<void>;
}

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
