// const debug = require('debug')('crowi:events:activity')
const { EventEmitter } = require('events')

class ActivityEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }
  onRemove(activity) {}
}

module.exports = ActivityEvent
