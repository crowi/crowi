import Crowi from 'server/crowi'

export default (crowi: Crowi) => {
  'use strict'

  // var debug = Debug('crowi:lib:fileUploader')
  const method = crowi.env.FILE_UPLOAD || 'aws'

  return require('../../local_modules/crowi-fileupload-' + method + '/index.js')(crowi)
}
