const debug = require('debug')('crowi:events:activity');
const util = require('util');
const events = require('events');

function ActivityEvent(crowi) {
  this.crowi = crowi;

  events.EventEmitter.call(this);
}
util.inherits(ActivityEvent, events.EventEmitter);

module.exports = ActivityEvent;
