/**
 * The context object passed to every plugin callback. It is the only
 * conduit through which a plugin reads core state (config, models,
 * crypto helpers, logging) — plugins must NOT import from
 * `@crowi/server` directly to keep the contract surface thin.
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

  /** Write a single config field, persisting to Mongo. */
  setConfig(key: string, value: unknown): Promise<void>;

  /** Per-Page metadata accessor for this plugin's namespace. */
  pageMetadata: PageMetadataAccessor;

  /**
   * Mongoose model accessor. Returns the named core model. Plugins
   * touch core collections (Page, User, Comment, ...) through this
   * accessor rather than importing model files directly.
   *
   * Typed loosely (`unknown`) at this layer because the core model
   * types live in `@crowi/server`; plugins narrow the return type at
   * the call site.
   */
  model(name: string): unknown;

  /** Symmetric encrypt / decrypt against the configured KeyProvider. */
  crypto: PluginCrypto;

  /** Structured logger scoped to this plugin (auto-prefixed with name). */
  log: PluginLogger;
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

export interface PluginCrypto {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
