'use strict';

function Notification (crowi)
{
  this.crowi = crowi;
  this.config = crowi.getConfig();
}

Notification.prototype.hasSlackConfig = function()
{
  if (!this.config.notification['slack']) {
    return false;
  }
  return undefined; // FIXME
  //var config = ;
};

Notification.prototype.noitfyByEmail = function()
{
};

Notification.prototype.noitfyByChat = function()
{
};

module.exports = Notification;
