import Crowi from 'server/crowi'
import { EventEmitter } from 'events'
// import Debug from 'debug'
// const debug = Debug('crowi:events:notification')

export default class NotificationEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }

  onUpdate(user) {}
}
