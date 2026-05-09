import Crowi from 'src/crowi';
import { EventEmitter } from 'node:events';
// import Debug from 'debug'

export default class SearchEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
  }
}
