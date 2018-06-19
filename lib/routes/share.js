module.exports = (crowi, app) => {
  'use strict'

  var debug = require('debug')('crowi:routes:share')
  var Share = crowi.model('Share')
  var ApiResponse = require('../util/apiResponse')
  var actions = {}

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
      const share = await Share.findShareById(id, Share.STATUS_ACTIVE)
      const shareId = share.id
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
    const { page_id: pageId } = req.query

    if (pageId === null) {
      return res.json(ApiResponse.error('Parameters page_id are required.'))
    }

    try {
      const shareData = await Share.find({ page: pageId })
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
      const shareData = await Share.findShareByPageId(pageId, Share.STATUS_ACTIVE)
      Share.delete(shareData)
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
      const share = await Share.findShareById(shareId, Share.STATUS_ACTIVE)
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
