import Crowi from 'src/crowi'

const fileUploader = {
  async uploadFile(filePath: string, type: string, fileStream: any, options: any) {
    throw new Error('Not implemented')
  },
  generateUrl(filePath: string) {
    throw new Error('Not implemented')
  },

  findDeliveryFile(attachmentId: string, filePath: string) {
    throw new Error('Not implemented')
  },

  deleteFile(attachmentId: string, filePath: string) {
    throw new Error('Not implemented')
  },
}

export default (crowi: Crowi) => {
  'use strict'

  // var debug = Debug('crowi:lib:fileUploader')
  //const method = crowi.env.FILE_UPLOAD || 'aws'

  //return require('../../local_modules/crowi-fileupload-' + method + '/index.js')(crowi)
  return fileUploader
}
