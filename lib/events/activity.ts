import { EventEmitter } from 'events'
import Crowi from 'server/crowi'
// import Debug from 'debug'
// const debug = Debug('crowi:events:activity')

export default class ActivityEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }

  onRemove(activity) {}
}
