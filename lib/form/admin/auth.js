'use strict'

var form = require('express-form')
var field = form.field

module.exports = form(field('settingForm[auth:requireThirdPartyAuth]').toBoolean(), field('settingForm[auth:disablePasswordAuth]').toBoolean())
