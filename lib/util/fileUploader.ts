import Crowi from 'server/crowi'

export default (crowi: Crowi) => {
  'use strict'

  // var debug = require('debug')('crowi:lib:fileUploader')
  var method = crowi.env.FILE_UPLOAD || 'aws'
  var lib = '../../local_modules/crowi-fileupload-' + method

  return require(lib)(crowi)
}
