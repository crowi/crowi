import { Request, Response } from 'express'
import Crowi from 'server/crowi'

export default (crowi: Crowi) => {
  return async function(req: Request, res: Response, next) {
    try {
      const Attachment = crowi.model('Attachment')
      const Share = crowi.model('Share')
      const attachment = await Attachment.findById(req.params.id)
      if (!attachment) {
        return res.sendStatus(404)
      }
      const { uuid, secretKeyword } = await Share.findShareByPageId(attachment.page, { status: Share.STATUS_ACTIVE })
      const { shareIds = [], secretKeywords = {} } = req.session
      const isNoExistKeyword = !secretKeyword
      const hasCorrectKeyword = secretKeywords[uuid] === secretKeyword
      const isAccessedSharedPage = shareIds.includes(uuid)
      const hasAccessRight = (isNoExistKeyword || hasCorrectKeyword) && isAccessedSharedPage
      if (hasAccessRight) {
        return next()
      }
    } catch (err) {
      // share url not found, but its okay
      // debug(err)
    }
    return crowi.middlewares.LoginRequired(req, res, next)
  }
}
