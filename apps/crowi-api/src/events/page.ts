import Crowi from 'src/crowi';
import { EventEmitter } from 'node:events';
import Debug from 'debug';

const debug = Debug('crowi:events:page');

export default class PageEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
    // EventEmitter's `on(name, listener)` does not bind `this` for the
    // listener, so we pre-bind here to keep `crowi.model(...)` accessible
    // from inside onCreate / onUpdate.
    this.onCreate = this.onCreate.bind(this);
    this.onUpdate = this.onUpdate.bind(this);
  }

  /**
   * Pages emit 'create' from Page.createPage with the freshly pushed
   * revision data. We register backlinks best-effort: any failure is
   * swallowed (with a debug log) so backlink registration never blocks
   * page creation.
   *
   * Replaces the legacy pageSchema.post('save') hook in models/page.ts
   * which fired on every save (including non-content updates) and could
   * not distinguish create from update.
   */
  onCreate(savedPage: unknown, _user: unknown) {
    this.registerBacklinks(savedPage);
  }

  /**
   * Pages emit 'update' from Page.updatePage. createBySavedPage handles
   * the diff internally: it removes existing backlinks for this fromPage
   * and then re-creates them from the latest revision body, so removed
   * links are reflected and new ones picked up.
   *
   * The third argument from Page.updatePage is `bookmarkCount`; we accept
   * it as `..._rest` to stay forwards-compatible without referencing it.
   */
  onUpdate(savedPage: unknown, _user: unknown, ..._rest: unknown[]) {
    this.registerBacklinks(savedPage);
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
}
