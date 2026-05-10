import Crowi from 'src/crowi';
import { EventEmitter } from 'node:events';
import Debug from 'debug';
import { indexPageInSearch, removePageFromSearch } from 'src/util/page-search-index';

const debug = Debug('crowi:events:page');

export default class PageEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
    // EventEmitter's `on(name, listener)` does not bind `this` for the
    // listener, so we pre-bind here to keep `crowi.model(...)` accessible
    // from inside onCreate / onUpdate / onDelete.
    this.onCreate = this.onCreate.bind(this);
    this.onUpdate = this.onUpdate.bind(this);
    this.onDelete = this.onDelete.bind(this);
  }

  /**
   * Pages emit 'create' from Page.createPage with the freshly pushed
   * revision data. We register backlinks best-effort and push the
   * page into the active search driver so it becomes searchable
   * immediately. Any failure is swallowed (with a debug log) so
   * neither blocks page creation.
   *
   * Replaces the legacy pageSchema.post('save') hook in models/page.ts
   * which fired on every save (including non-content updates) and could
   * not distinguish create from update.
   */
  onCreate(savedPage: unknown, _user: unknown) {
    this.registerBacklinks(savedPage);
    this.updateSearchIndex(savedPage);
  }

  /**
   * Pages emit 'update' from Page.updatePage. Backlinks
   * (createBySavedPage handles the diff internally) and the search
   * index are both refreshed.
   *
   * The third argument from Page.updatePage is `bookmarkCount`; we accept
   * it as `..._rest` to stay forwards-compatible without referencing it.
   */
  onUpdate(savedPage: unknown, _user: unknown, ..._rest: unknown[]) {
    this.registerBacklinks(savedPage);
    this.updateSearchIndex(savedPage);
  }

  /**
   * Pages emit 'delete' from Page.completelyDeletePage (hard delete).
   * Soft delete (= move to trash) flows through 'update' with
   * `status='deleted'`, which `indexPageInSearch` translates into
   * a `searcher.remove()` call.
   */
  onDelete(savedPage: unknown, _user: unknown) {
    if (typeof savedPage !== 'object' || savedPage === null) return;
    const id = (savedPage as { _id?: { toString: () => string } | string })._id;
    if (id === undefined) return;
    void removePageFromSearch(this.crowi, typeof id === 'string' ? id : id.toString());
  }

  private registerBacklinks(savedPage: unknown) {
    const Backlink = this.crowi.model('Backlink');
    Promise.resolve()
      .then(() => Backlink.createBySavedPage(savedPage))
      .catch((err) => {
        // Best-effort: never propagate. Surface only via debug logs.
        debug('backlink: failed to register backlink', err);
      });
  }

  private updateSearchIndex(savedPage: unknown) {
    if (typeof savedPage !== 'object' || savedPage === null) return;
    const page = savedPage as { _id?: { toString: () => string } | string };
    if (!page._id) return;
    void indexPageInSearch(this.crowi, page as Parameters<typeof indexPageInSearch>[1]);
  }
}
