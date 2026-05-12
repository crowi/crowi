import Crowi from 'src/crowi';
import { EventEmitter } from 'node:events';

export default class ConfigEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
  }
}
