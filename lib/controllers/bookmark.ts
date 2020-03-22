import Crowi from 'server/crowi'
import Debug from 'debug'
import ApiResponse from '../utils/apiResponse'
import ApiPaginate from '../utils/apiPaginate'

export default (crowi: Crowi) => {
  const debug = Debug('crowi:routes:bookmark')
  const Bookmark = crowi.model('Bookmark')
  const Page = crowi.model('Page')
  const actions = {} as any
  actions.api = {} as any

  /**
   * @api {get} /bookmarks.get Get bookmark of the page with the user
   * @apiName GetBookmarks
   * @apiGroup Bookmark
   *
   * @apiParam {String} page_id Page Id.
   */
  actions.api.get = function(req, res) {
    var pageId = req.query.page_id

    Bookmark.findByPageIdAndUserId(pageId, req.user)
      .then(function(bookmark) {
        debug('bookmark found', pageId, bookmark)
        const result = { bookmark }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   *
   */
  actions.api.list = function(req, res) {
    var paginateOptions = ApiPaginate.parseOptions(req.query)

    var options = Object.assign(paginateOptions, { populatePage: true })
    Bookmark.findByUserId(req.user._id, options)
      .then(function(result) {
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {post} /bookmarks.add Add bookmark of the page
   * @apiName AddBookmark
   * @apiGroup Bookmark
   *
   * @apiParam {String} page_id Page Id.
   */
  actions.api.add = function(req, res) {
    var pageId = req.body.page_id

    Page.findPageByIdAndGrantedUser(pageId, req.user)
      .then(function(pageData) {
        if (pageData) {
          return Bookmark.add(pageData, req.user)
        } else {
          return res.json(ApiResponse.success({ bookmark: null }))
        }
      })
      .then(function(bookmark) {
        bookmark.depopulate('page')
        bookmark.depopulate('user')

        const result = { bookmark }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {post} /bookmarks.remove Remove bookmark of the page
   * @apiName RemoveBookmark
   * @apiGroup Bookmark
   *
   * @apiParam {String} page_id Page Id.
   */
  actions.api.remove = function(req, res) {
    var pageId = req.body.page_id

    Bookmark.removeBookmark(pageId, req.user)
      .then(function(data) {
        debug('Bookmark removed.', data) // if the bookmark is not exists, this 'data' is null
        return res.json(ApiResponse.success())
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  return actions
}
