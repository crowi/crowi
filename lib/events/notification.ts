import { EventEmitter } from 'events'
// import Debug from 'debug'
// const debug = Debug('crowi:events:notification')

export default class NotificationEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }

  onUpdate(user) {}
}
