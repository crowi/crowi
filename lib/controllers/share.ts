import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import ApiResponse from '../utils/apiResponse'
import { PageDocument } from 'server/models/page'
import { UserDocument } from 'server/models/user'

export default (crowi: Crowi) => {
  const debug = Debug('crowi:routes:share')
  const Share = crowi.model('Share')
  const ShareAccess = crowi.model('ShareAccess')
  const Tracking = crowi.model('Tracking')
  const actions = {} as any

  async function firstOrCreateTrackingId(req) {
    const { trackingId } = req.session
    debug('ShereAccess from session', trackingId)
    if (!trackingId) {
      const userAgent = req.headers['user-agent']
      const remoteAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress
      const tracking = await Tracking.create({ userAgent, remoteAddress })
      debug('ShereAccess new created', tracking._id)
      return tracking._id
    }
    return trackingId
  }

  async function addAccessLog(req, share) {
    const trackingId = await firstOrCreateTrackingId(req)
    try {
      ShareAccess.access(share._id, trackingId)
    } catch (err) {
      console.error(err)
    }

    return trackingId
  }

  function hasAccessAuthority(secretKeywords, { uuid, secretKeyword }) {
    return !secretKeyword || secretKeywords[uuid] === secretKeyword
  }

  function updateShareIds(shareIds, id) {
    const unique = (id, index, array) => array.indexOf(id) === index
    return shareIds
      .concat(id)
      .filter(Boolean)
      .filter(unique)
  }

  function isExternalShareEnabled() {
    const config = crowi.getConfig()
    return Boolean(config.crowi['app:externalShare'])
  }

  actions.pageShow = async (req: Request, res: Response) => {
    const { uuid } = req.params
    const { shareIds = [], secretKeywords = {} } = req.session

    if (!isExternalShareEnabled()) {
      res.status(405)
      return res.render('405.html')
    }

    try {
      const share = await Share.findShareByUuid(uuid, { status: Share.STATUS_ACTIVE })
      const shareId = share.uuid
      const trackingId = await addAccessLog(req, share)
      req.session.trackingId = trackingId

      if (hasAccessAuthority(secretKeywords, share)) {
        req.session.shareIds = updateShareIds(shareIds, uuid)
        const page = (share.page as any) as PageDocument
        const { path = '', revision = {} } = page

        return res.render('page_share.html', { hasSecretKeyword: true, shareId, page, path, revision })
      }

      return res.render('page_share.html', { hasSecretKeyword: false, shareId })
    } catch (err) {
      console.error(err)
      return res.redirect('/')
    }
  }

  const api = (actions.api = {} as any)

  api.list = async (req: Request, res: Response) => {
    // list is allowed if the feature is disabled because it is used in admin page

    let { page_id: pageId, page = 1, limit = 50, populate_accesses: populateAccesses = false } = req.query
    page = parseInt(page)
    limit = parseInt(limit)
    const query = pageId ? { page: pageId } : {}
    const options = { page, limit, populateAccesses }
    try {
      const shareData = await Share.findShares(query, options)
      const result = { share: shareData }

      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  api.get = async (req: Request, res: Response) => {
    const { page_id: pageId, populate_accesses: populateAccesses = false } = req.query

    if (pageId === null) {
      return res.json(ApiResponse.error('Parameters page_id is required.'))
    }

    try {
      const shareData = await Share.findShareByPageId(pageId, { status: Share.STATUS_ACTIVE }, { populateAccesses })
      const result = { share: shareData }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  /**
   * @api {post} /shares.create Create new share
   * @apiName CreateShare
   * @apiGroup Share
   *
   * @apiParam {String} id
   * @apiParam {String} page_id
   */
  api.create = async (req: Request, res: Response) => {
    const user = req.user as UserDocument

    if (!isExternalShareEnabled()) {
      return res.status(405)
    }

    const { page_id: pageId = null } = req.body

    if (pageId === null) {
      return res.json(ApiResponse.error('Parameters id and page_id are required.'))
    }

    try {
      const shareData = await Share.createShare(pageId, user._id)
      if (!shareData) {
        throw new Error('Failed to create share.')
      }
      const result = { share: shareData.toObject() }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  /**
   * @api {post} /shares.delete Delete share
   * @apiName DeleteShare
   * @apiGroup Share
   *
   * @apiParam {String} page_id Page Id.
   */
  api.delete = async (req: Request, res: Response) => {
    if (!isExternalShareEnabled()) {
      return res.status(405)
    }

    const { page_id: pageId } = req.body

    try {
      const shareData = await Share.findShareByPageId(pageId, { status: Share.STATUS_ACTIVE })
      await Share.deleteById(shareData.id)
      debug('Share deleted', shareData.id)
      const result = { share: shareData.toObject() }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      debug('Error occured while get setting', err, err.stack)
      return res.json(ApiResponse.error('Failed to delete share.'))
    }
  }

  api.setSecretKeyword = async (req: Request, res: Response) => {
    if (!isExternalShareEnabled()) {
      return res.status(405)
    }

    const { share_id: shareId, secret_keyword: secretKeyword } = req.body

    try {
      const share = await Share.findShareByUuid(shareId)
      share.secretKeyword = secretKeyword
      const shareData = await share.save()
      const result = { share: shareData.toObject() }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      debug('Error occured while update secret keyword', err, err.stack)
      return res.json(ApiResponse.error('Failed to update secret keyword.'))
    }
  }

  api.checkSecretKeyword = async (req: Request, res: Response) => {
    if (!isExternalShareEnabled()) {
      return res.status(405)
    }

    const { share_id: shareId, secret_keyword: secretKeyword } = req.body
    const { shareIds = [], secretKeywords = {} } = req.session

    req.session.secretKeywords = Object.assign(secretKeywords, { [shareId]: secretKeyword })
    try {
      const share = await Share.findShareByUuid(shareId, { status: Share.STATUS_ACTIVE })
      const result = { hasAccessAuthority: hasAccessAuthority(req.session.secretKeywords, share) }
      if (result.hasAccessAuthority) {
        req.session.shareIds = updateShareIds(shareIds, shareId)
      }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
