import Crowi from 'server/crowi'
import { EventEmitter } from 'events'
// import Debug from 'debug'
// const debug = Debug('crowi:events:page')

export default class BookmarkEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }

  onCreate(bookmark) {}

  onDelete(bookmark) {}
}
