import Crowi from 'server/crowi'
import { EventEmitter } from 'events'
// import Debug from 'debug'
// const debug = Debug('crowi:events:page')

export default class PageEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }

  onCreate(page, user) {}

  onUpdate(page, user) {}
}
