import Crowi from 'server/crowi'
import { EventEmitter } from 'events'

export default class ConfigEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }
}
