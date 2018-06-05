'use strict'

var form = require('express-form')
var field = form.field

module.exports = form(field('apiTokenForm.confirm').required())
