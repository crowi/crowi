
import { EventEmitter } from 'events'
// import Debug from 'debug'
// const debug = Debug('crowi:events:activity')

export default class ActivityEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }

  onRemove(activity) {}
}
