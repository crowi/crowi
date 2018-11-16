// const debug = require('debug')('crowi:events:page')
const { EventEmitter } = require('events')

class PageEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }
  onCreate(page, user) {}
  onUpdate(page, user) {}
}

module.exports = PageEvent
