/**
 * fileUploader
 */

module.exports = function(crowi) {
  'use strict'

  var debug = require('debug')('crowi:lib:fileUploader')
  var method = crowi.env.FILE_UPLOAD || 'aws'
  var lib = '../../local_modules/crowi-fileupload-' + method

  return require(lib)(crowi)
}
