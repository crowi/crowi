import { EventEmitter } from 'events'
// import Debug from 'debug'

export default class SearchEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }
}
