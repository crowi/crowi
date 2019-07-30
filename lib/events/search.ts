import Crowi from 'server/crowi'
import { EventEmitter } from 'events'
// import Debug from 'debug'

export default class SearchEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }
}
