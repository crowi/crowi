'use strict'

var form = require('express-form')
var field = form.field
var stringToArray = require('../../util/formUtil').stringToArrayFilter
var normalizeCRLF = require('../../util/formUtil').normalizeCRLFFilter

module.exports = form(
  field('settingForm[security:basicName]'),
  field('settingForm[security:basicSecret]'),
  field('settingForm[security:registrationMode]').required(),
  field('settingForm[security:registrationWhiteList]')
    .custom(normalizeCRLF)
    .custom(stringToArray),
)
