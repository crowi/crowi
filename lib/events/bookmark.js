// var debug = require('debug')('crowi:events:page')
const { EventEmitter } = require('events')

class BookmarkEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }

  onCreate(bookmark) {}
  onDelete(bookmark) {}
}

module.exports = BookmarkEvent
