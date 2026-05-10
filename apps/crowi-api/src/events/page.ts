import Crowi from 'src/crowi';
import { EventEmitter } from 'node:events';
import Debug from 'debug';
import type { PageLike } from 'src/util/page-response';
import { indexPageInSearch, removePageFromSearch } from 'src/util/page-search-index';

const debug = Debug('crowi:events:page');

const isPageLike = (value: unknown): value is PageLike => typeof value === 'object' && value !== null && '_id' in value;

export default class PageEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
    // EventEmitter's `on(name, listener)` does not bind `this` for the
    // listener; pre-bind so `this.crowi` is reachable from inside.
    this.onCreate = this.onCreate.bind(this);
    this.onUpdate = this.onUpdate.bind(this);
    this.onDelete = this.onDelete.bind(this);
  }

  onCreate(savedPage: unknown, _user: unknown) {
    this.registerBacklinks(savedPage);
    if (isPageLike(savedPage)) void indexPageInSearch(this.crowi, savedPage);
  }

  // Page.updatePage's third arg is `bookmarkCount`; accepted via rest
  // for forwards compatibility without referencing it.
  onUpdate(savedPage: unknown, _user: unknown, ..._rest: unknown[]) {
    this.registerBacklinks(savedPage);
    if (isPageLike(savedPage)) void indexPageInSearch(this.crowi, savedPage);
  }

  // Hard delete (Page.completelyDeletePage). Soft delete flows through
  // 'update' with `status='deleted'` and is handled by indexPageInSearch.
  onDelete(savedPage: unknown, _user: unknown) {
    if (isPageLike(savedPage)) void removePageFromSearch(this.crowi, savedPage);
  }

  private registerBacklinks(savedPage: unknown) {
    const Backlink = this.crowi.model('Backlink');
    Promise.resolve()
      .then(() => Backlink.createBySavedPage(savedPage))
      .catch((err) => {
        debug('backlink: failed to register backlink', err);
      });
  }
}
