import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import ApiResponse from '../utils/apiResponse'

export default (crowi: Crowi) => {
  const debug = Debug('crowi:routes:revision')
  const Page = crowi.model('Page')
  const Revision = crowi.model('Revision')
  const actions = {} as any
  actions.api = {} as any

  /**
   * @api {get} /revisions.get Get revision
   * @apiName GetRevision
   * @apiGroup Revision
   *
   * @apiParam {String} revision_id Revision Id.
   */
  actions.api.get = function(req: Request, res: Response) {
    const revisionId = req.query.revision_id

    Revision.findRevision(revisionId)
      .then(function(revisionData) {
        const result = {
          revision: revisionData,
        }
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('Error revisios.get', err)
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {get} /revisions.ids Get revision id list of the page
   * @apiName ids
   * @apiGroup Revision
   *
   * @apiParam {String} page_id      Page Id.
   */
  actions.api.ids = function(req: Request, res: Response) {
    const pageId = req.query.page_id || null

    if (pageId && crowi.isPageId(pageId)) {
      Page.findPageByIdAndGrantedUser(pageId, req.user)
        .then(function(pageData) {
          debug('Page found', pageData._id, pageData.path)
          return Revision.findRevisionIdList(pageData.path)
        })
        .then(function(revisions) {
          return res.json(ApiResponse.success({ revisions }))
        })
        .catch(function(err) {
          return res.json(ApiResponse.error(err))
        })
    } else {
      return res.json(ApiResponse.error('Parameter error.'))
    }
  }

  /**
   * @api {get} /revisions.list Get revisions
   * @apiName ListRevision
   * @apiGroup Revision
   *
   * @apiParam {String} revision_ids Revision Ids.
   * @apiParam {String} page_id      Page Id.
   */
  actions.api.list = function(req: Request, res: Response) {
    const revisionIds = (req.query.revision_ids || '').split(',')
    const pageId = req.query.page_id || null

    if (pageId) {
      Page.findPageByIdAndGrantedUser(pageId, req.user)
        .then(function(pageData) {
          debug('Page found', pageData._id, pageData.path)
          return Revision.findRevisionList(pageData.path, {})
        })
        .then(function(revisions) {
          return res.json(ApiResponse.success(revisions))
        })
        .catch(function(err) {
          return res.json(ApiResponse.error(err))
        })
    } else if (revisionIds.length > 0) {
      Revision.findRevisions(revisionIds)
        .then(function(revisions) {
          return res.json(ApiResponse.success(revisions))
        })
        .catch(function(err) {
          return res.json(ApiResponse.error(err))
        })
    } else {
      return res.json(ApiResponse.error('Parameter error.'))
    }
  }

  return actions
}
