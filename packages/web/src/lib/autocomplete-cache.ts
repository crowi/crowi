/**
 * RFC-0004 Phase 5 — client-side LRU cache for autocomplete results.
 *
 * Autocomplete fires on every debounced keystroke; without a cache,
 * deleting and re-typing a character would re-hit the server. The RFC
 * specifies a small LRU — **50 entries, 30s TTL** — keyed by
 * `(kind, query)`. The "Refresh results" dropdown affordance bypasses
 * the cache (see `autocomplete-extension.ts`) so a freshly-added user
 * or page can still be found without waiting out the TTL.
 *
 * This module is a pure data structure with no DOM / network deps so
 * it is unit-testable in isolation.
 */

/** Which endpoint a cached entry came from — part of the cache key. */
export type AutocompleteKind = 'user' | 'page';

const MAX_ENTRIES = 50;
const TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  /** Wall-clock time the entry was stored; used for TTL eviction. */
  storedAt: number;
}

/**
 * Fixed-capacity LRU cache with per-entry TTL. `Map` preserves
 * insertion order, so "least-recently-used" is "first key" — a `get`
 * that hits re-inserts the key to move it to the most-recent end.
 */
export class AutocompleteCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxEntries: number = MAX_ENTRIES,
    private readonly ttlMs: number = TTL_MS,
    /** Injectable clock so tests can drive TTL deterministically. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Compose the cache key from the entry kind and the typed query. */
  private static key(kind: AutocompleteKind, query: string): string {
    return `${kind}::${query.toLowerCase()}`;
  }

  /**
   * Look up a cached result. Returns `undefined` on a miss or when the
   * entry has expired (an expired entry is dropped on access). A hit
   * is promoted to most-recently-used.
   */
  get(kind: AutocompleteKind, query: string): T | undefined {
    const key = AutocompleteCache.key(kind, query);
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (this.now() - entry.storedAt > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }

    // Promote to most-recently-used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * Store a result, evicting the least-recently-used entry when the
   * cache is at capacity.
   */
  set(kind: AutocompleteKind, query: string, value: T): void {
    const key = AutocompleteCache.key(kind, query);
    // Delete first so a re-set moves the key to the most-recent end.
    this.store.delete(key);
    this.store.set(key, { value, storedAt: this.now() });

    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /** Drop a single entry — used by "Refresh results" to force a re-query. */
  invalidate(kind: AutocompleteKind, query: string): void {
    this.store.delete(AutocompleteCache.key(kind, query));
  }

  /** Drop every entry. */
  clear(): void {
    this.store.clear();
  }

  /** Current entry count — for tests / diagnostics. */
  get size(): number {
    return this.store.size;
  }
}
