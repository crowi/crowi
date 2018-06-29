module.exports = (crowi, app) => {
  'use strict'

  const debug = require('debug')('crowi:routes:share')
  const Share = crowi.model('Share')
  const Tracking = crowi.model('Tracking')
  const ApiResponse = require('../util/apiResponse')
  const actions = {}

  async function firstOrCreateTrackingId(req) {
    const { trackingId } = req.session
    if (!trackingId) {
      const userAgent = req.headers['user-agent']
      const remoteAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress
      const tracking = await Tracking.create({ userAgent, remoteAddress })
      req.session.trackingId = tracking._id
      return tracking._id
    }
    return trackingId
  }

  async function addAccessLog(req, share) {
    const trackingId = await firstOrCreateTrackingId(req)
    return share.access(share._id, trackingId)
  }

  function hasAccessAuthority(secretKeywords, { id, secretKeyword }) {
    return !secretKeyword || secretKeywords[id] === secretKeyword
  }

  function updateShareIds(shareIds, id) {
    const unique = (id, index, array) => array.indexOf(id) === index
    return shareIds
      .concat(id)
      .filter(Boolean)
      .filter(unique)
  }

  actions.pageShow = async (req, res) => {
    const { id } = req.params
    const { shareIds = [], secretKeywords = {} } = req.session
    try {
      const share = await Share.findShareById(id, { status: Share.STATUS_ACTIVE })
      const shareId = share.id
      await addAccessLog(req, share)
      if (hasAccessAuthority(secretKeywords, share)) {
        req.session.shareIds = updateShareIds(shareIds, id)
        const page = share.page
        const { path = '', revision = {} } = page
        return res.render('page_share', { hasSecretPassword: true, shareId, page, path, revision })
      }
      return res.render('page_share', { hasSecretPassword: false, shareId })
    } catch (err) {
      console.log(err)
      return res.redirect('/')
    }
  }

  const api = (actions.api = {})

  api.list = async (req, res) => {
    let { page_id: pageId, page = 1, limit = 50 } = req.query
    page = parseInt(page)
    limit = parseInt(limit)
    const query = pageId ? { page: pageId } : {}
    const options = { page, limit }
    try {
      const shareData = await Share.findShares(query, options)
      const result = { share: shareData }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  api.get = async (req, res) => {
    const { page_id: pageId } = req.query

    if (pageId === null) {
      return res.json(ApiResponse.error('Parameters page_id is required.'))
    }

    try {
      const shareData = await Share.findShareByPageId(pageId, { status: Share.STATUS_ACTIVE })
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
  api.create = async (req, res) => {
    const { page_id: pageId = null } = req.body

    if (pageId === null) {
      return res.json(ApiResponse.error('Parameters id and page_id are required.'))
    }

    try {
      const shareData = await Share.create(pageId, req.user)
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
  api.delete = async (req, res) => {
    const { page_id: pageId } = req.body

    try {
      const shareData = await Share.findShareByPageId(pageId, { status: Share.STATUS_ACTIVE })
      await Share.delete(shareData)
      debug('Share deleted', shareData.id)
      const result = { share: shareData.toObject() }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      debug('Error occured while get setting', err, err.stack)
      return res.json(ApiResponse.error('Failed to delete share.'))
    }
  }

  api.setSecretKeyword = async (req, res) => {
    const { share_id: shareId, secret_keyword: secretKeyword } = req.body

    try {
      const share = await Share.findShareById(shareId)
      share.secretKeyword = secretKeyword
      const shareData = await share.save()
      const result = { share: shareData.toObject() }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      debug('Error occured while update secret keyword', err, err.stack)
      return res.json(ApiResponse.error('Failed to update secret keyword.'))
    }
  }

  api.checkSecretKeyword = async (req, res) => {
    const { share_id: shareId, secret_keyword: secretKeyword } = req.body
    const { shareIds = [], secretKeywords = {} } = req.session

    req.session.secretKeywords = Object.assign(secretKeywords, { [shareId]: secretKeyword })
    try {
      const share = await Share.findShareById(shareId, { status: Share.STATUS_ACTIVE })
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
