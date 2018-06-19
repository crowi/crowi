module.exports = (crowi, app) => {
  'use strict'

  var debug = require('debug')('crowi:routes:share')
  var Share = crowi.model('Share')
  var ApiResponse = require('../util/apiResponse')
  var actions = {}

  async function renderPage(pageData, req, res) {
    var renderVars = {
      path: pageData.path,
      page: pageData,
      revision: pageData.revision || {},
      author: pageData.revision.author || false,
    }

    try {
      res.render('page_share', renderVars)
    } catch (err) {
      debug('Error: renderPage()', err)
      res.redirect('/')
    }
  }

  actions.pageShow = async (req, res) => {
    const { id } = req.params
    const { shareIds } = req.session
    try {
      const share = await Share.findShareById(id, Share.STATUS_ACTIVE)
      const unique = (id, index, array) => array.indexOf(id) === index
      req.session.shareIds = []
        .concat(shareIds, id)
        .filter(Boolean)
        .filter(unique)
      return renderPage(share.page, req, res)
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
    const { page_id: pageId } = req.body

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

  api.secretKeyword = async (req, res) => {
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

  return actions
}
