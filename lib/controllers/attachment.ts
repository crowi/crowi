import { Express, Request, Response } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import fs from 'fs'
import FileUploader from '../utils/fileUploader'
import ApiResponse from '../utils/apiResponse'
import { UserDocument } from 'server/models/user'

export default (crowi: Crowi, app: Express) => {
  const debug = Debug('crowi:routs:attachment')
  const Attachment = crowi.model('Attachment')
  const Page = crowi.model('Page')
  const fileUploader = FileUploader(crowi)
  const actions = {} as any
  const api = {} as any

  actions.api = api

  api.redirector = function(req: Request, res: Response) {
    var id = req.params.id

    Attachment.findById(id)
      .then(function(data) {
        if (!data) {
          throw new Error('File not found')
        }
        // TODO: file delivery plugin for cdn
        Attachment.findDeliveryFile(data)
          .then(fileName => {
            const encodedFileName = encodeURIComponent(data.originalName)

            var deliveryFile = {
              fileName: fileName,
              options: {
                headers: {
                  'Content-Type': data.fileFormat,
                  'Content-Disposition': `inline;filename*=UTF-8''${encodedFileName}`,
                },
              },
            }

            if (deliveryFile.fileName.match(/^\/uploads/)) {
              debug('Using loacal file module, just redirecting.')
              return res.redirect(deliveryFile.fileName)
            } else {
              return res.sendFile(deliveryFile.fileName, deliveryFile.options)
            }
          })
          .catch(err => {
            // debug('error', err);
          })
      })
      .catch(err => {
        // debug('err', err);
        // not found
        return res.status(404).sendFile(crowi.publicDir + '/images/file-not-found.png')
      })
  }

  /**
   * @api {get} /attachments.list Get attachments of the page
   * @apiName ListAttachments
   * @apiGroup Attachment
   *
   * @apiParam {String} page_id
   */
  api.list = function(req: Request, res: Response) {
    var id = req.query.page_id || null
    if (!id) {
      return res.json(ApiResponse.error('Parameters page_id is required.'))
    }

    Attachment.getListByPageId(id).then(function(attachments) {
      var config = crowi.getConfig()
      var baseUrl = config.crowi['app:url'] || ''
      return res.json(
        ApiResponse.success({
          attachments: attachments.map(at => {
            var fileUrl = at.fileUrl
            at = at.toObject()
            at.url = baseUrl + fileUrl
            return at
          }),
        }),
      )
    })
  }

  /**
   * @api {post} /attachments.add Add attachment to the page
   * @apiName AddAttachments
   * @apiGroup Attachment
   *
   * @apiParam {String} page_id
   * @apiParam {File} file
   */
  api.add = async function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const id = req.body.page_id || 0
    const path = decodeURIComponent(req.body.path) || null
    let pageCreated = false

    debug('id and path are: ', id, path)

    const tmpFile = req.file || null
    debug('Uploaded tmpFile: ', tmpFile)
    if (!tmpFile) {
      return res.json(ApiResponse.error('File error.'))
    }

    try {
      let pageData
      if (id == 0) {
        if (path === null) {
          throw new Error('path required if page_id is not specified.')
        }
        debug('Create page before file upload')
        pageData = await Page.createPage(path, '# ' + path, user, { grant: Page.GRANT_OWNER })
        pageCreated = true
      } else {
        pageData = await Page.findPageById(id)
      }

      const tmpPath = tmpFile.path
      const originalName = tmpFile.originalname
      const fileName = tmpFile.filename + tmpFile.originalname
      const fileType = tmpFile.mimetype
      const fileSize = tmpFile.size
      const pageId = pageData._id
      const creator = user._id
      const fileFormat = fileType

      try {
        const filePath = Attachment.createAttachmentFilePath(pageId, fileName, fileType)
        const tmpFileStream = fs.createReadStream(tmpPath, {
          flags: 'r',
          mode: 666,
          autoClose: true,
        })

        const data = await fileUploader.uploadFile(filePath, fileType, tmpFileStream, {})
        debug('Uploaded data is: ', data)

        // TODO size
        const attachment = await Attachment.create({ page: pageId, creator, filePath, originalName, fileName, fileFormat, fileSize })
        let fileUrl = attachment.fileUrl
        const config = crowi.getConfig()

        // isLocalUrl??
        if (!fileUrl.match(/^https?/)) {
          fileUrl = (config.crowi['app:url'] || '') + fileUrl
        }

        const result = {
          page: pageData.toObject(),
          attachment: attachment.toObject(),
          url: fileUrl,
          pageCreated: pageCreated,
        }

        // delete anyway
        fs.unlink(tmpPath, function(err) {
          if (err) {
            debug('Error while deleting tmp file.')
          }
        })

        return res.json(ApiResponse.success(result))
      } catch (err) {
        debug('Error on saving attachment data', err)
        // @TODO
        // Remove from S3

        // delete anyway
        fs.unlink(tmpPath, function(err) {
          if (err) {
            debug('Error while deleting tmp file.')
          }
        })

        return res.json(ApiResponse.error('Error while uploading.'))
      }
    } catch (err) {
      debug('Attachement upload error', err)
      return res.json(ApiResponse.error('Error.'))
    }
  }

  /**
   * @api {post} /attachments.remove Remove attachments
   * @apiName RemoveAttachments
   * @apiGroup Attachment
   *
   * @apiParam {String} attachment_id
   */
  api.remove = function(req: Request, res: Response) {
    const id = req.body.attachment_id

    Attachment.findById(id)
      .then(function(attachment) {
        if (!attachment) throw new Error('Attachment not found')

        Attachment.removeAttachment(attachment)
          .then(data => {
            debug('removeAttachment', data)
            return res.json(ApiResponse.success({}))
          })
          .catch(err => {
            return res.status(500).json(ApiResponse.error('Error while deleting file'))
          })
      })
      .catch(err => {
        debug('Error', err)
        return res.status(404)
      })
  }

  return actions
}
