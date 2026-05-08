/**
 * Document shape passed to `index()`. Mirrors the fields the legacy
 * search service indexes (path / body / title / tags / metadata).
 * Drivers may project a subset; `id` and `body` are required.
 */
export interface SearchableDoc {
  id: string;
  path: string;
  body: string;
  /** Optional human-friendly title (often derived from the first heading). */
  title?: string;
  tags?: string[];
  /**
   * Free-form metadata for driver-specific use. Not searchable through
   * the contract; drivers that want to surface custom fields should
   * declare them in their own configSchema.
   */
  meta?: Record<string, unknown>;
}

/**
 * Search request. Intentionally minimal in v2.0 — query string + paging
 * + optional filters. Richer queries (faceting, highlighting, custom
 * scoring) are deferred to a future RFC.
 */
export interface SearchQuery {
  q: string;
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Items per page. Defaults to 50, capped at 200. */
  limit?: number;
  /** Optional path-prefix filter (e.g. `/team/eng/`). */
  pathPrefix?: string;
}

export interface SearchHit {
  id: string;
  path: string;
  /**
   * Optional ranked snippet around the match. Drivers may return raw
   * text or HTML with the matched terms wrapped in `<mark>`; consumers
   * must sanitise for HTML render.
   */
  snippet?: string;
  /** Driver-specific relevance score; higher is better. */
  score?: number;
}

export interface SearchHits {
  total: number;
  hits: SearchHit[];
}

/**
 * Search backend driver. Active driver is selected by
 * `crowi.config.json:search.driver`. The default is `'mongo'` (Mongo
 * `$regex` over path / title / body), provided by `@crowi/search-mongo`.
 */
export interface SearchDriver {
  /**
   * Index or update a document. Called from the page-saved event hook;
   * implementations must be idempotent on the same `doc.id`.
   */
  index(doc: SearchableDoc): Promise<void>;

  /** Remove a document from the index. Idempotent. */
  remove(id: string): Promise<void>;

  /** Run a search query and return hits ordered by relevance. */
  query(q: SearchQuery): Promise<SearchHits>;

  /**
   * Optional: rebuild the full index from scratch. Triggered by the
   * admin "Rebuild index" maintenance op. Drivers without a persistent
   * index (e.g. Mongo regex) can omit this.
   */
  rebuild?(): Promise<void>;
}

export interface SearchRegistry {
  register(driverName: string, driver: SearchDriver): void;
}
