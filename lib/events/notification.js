// const debug = require('debug')('crowi:events:notification')
const { EventEmitter } = require('events')

class NotificationEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }

  onUpdate(user) {}
}

module.exports = NotificationEvent
