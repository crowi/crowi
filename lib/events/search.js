const { EventEmitter } = require('events')

class SearchEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }
}

module.exports = SearchEvent
