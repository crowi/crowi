import { Request, Response } from 'express'
import Crowi from 'src/crowi'
import ApiResponse from 'src/util/apiResponse'
import { getQueryAsString } from 'src/types/express'
import { Types } from 'mongoose'

export default (crowi: Crowi) => {
  // var debug = Debug('crowi:routes:backlink')
  const Backlink = crowi.model('Backlink')
  const actions = {} as any
  actions.api = {} as any

  /**
   * @api {list} /backlink.list Get list backlinks of the page
   * @apiName ListBackLink
   * @apiGroup Backlink
   *
   * @apiParam {String} page_id Page Id.
   * @apiParam {Number} limit
   * @apiParam {Number} offset
   */
  actions.api.list = async function (req: Request, res: Response) {
    const pageId = getQueryAsString(req.query.pageId)
    const limit = req.query.limit || 20
    const offset = req.query.offset || 0

    if (!pageId) {
      return res.json(ApiResponse.error('pageId is required'))
    }

    try {
      const objectId = new Types.ObjectId(pageId)
      const backlinks = await Backlink.findByPageId(objectId, limit, offset)
      return res.json(ApiResponse.success({ backlinks }))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
