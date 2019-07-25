
import { EventEmitter } from 'events'
// import Debug from 'debug'
// const debug = Debug('crowi:events:page')

export default class BookmarkEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }

  onCreate(bookmark) {}

  onDelete(bookmark) {}
}
