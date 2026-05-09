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
 * Page-type filter. Mirrors the legacy ES Searcher's portal/public/user
 * filter, generalised so future drivers (Mongo, Meilisearch, Algolia)
 * can implement them with their own backend semantics.
 *
 * - `portal`: directory-style pages (path ends with `/`), excluding `/user/*`
 * - `public`: leaf pages (path does not end with `/`), excluding `/user/*`
 * - `user`:   `/user/*` pages
 */
export type SearchPageType = 'portal' | 'public' | 'user';

/**
 * The viewer running the search. Drivers consult this to apply
 * grant-aware filtering: pages with `GRANT_OWNER` / `GRANT_RESTRICTED`
 * / `GRANT_SPECIFIED` are only visible to listed users; the driver
 * builds the filter so callers can stay grant-agnostic.
 */
export interface SearchQueryViewer {
  /** Mongo ObjectId string of the user. */
  id: string;
  username: string;
  isAdmin?: boolean;
}

export interface SearchQueryGrants {
  /** Restrict results to one or more page types. */
  types?: SearchPageType[];
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
  /**
   * Identity of the user running the search. When set, drivers apply
   * grant-aware filtering so private pages (owner-only / restricted)
   * are hidden from non-authorised viewers. When omitted, drivers
   * return only public pages (anonymous behaviour).
   */
  viewer?: SearchQueryViewer;
  /** Page-type / metadata filters. */
  grants?: SearchQueryGrants;
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
