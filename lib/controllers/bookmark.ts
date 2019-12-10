import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import ApiResponse from '../utils/apiResponse'
import ApiPaginate from '../utils/apiPaginate'
import { UserDocument } from 'server/models/user'

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
  actions.api.get = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    var pageId = req.query.page_id

    Bookmark.findByPageIdAndUserId(pageId, user._id)
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
  actions.api.list = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    var paginateOptions = ApiPaginate.parseOptions(req.query)

    var options = Object.assign(paginateOptions, { populatePage: true })
    Bookmark.findByUserId(user._id, options)
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
  actions.api.add = async function(req: Request, res: Response) {
    var pageId = req.body.page_id

    try {
      const pageData = await Page.findPageByIdAndGrantedUser(pageId, req.user)

      if (pageData) {
        const bookmark = await Bookmark.add(pageData, req.user)

        bookmark.depopulate('page')
        bookmark.depopulate('user')

        const result = { bookmark }

        return res.json(ApiResponse.success(result))
      } else {
        return res.json(ApiResponse.success({ bookmark: null }))
      }
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  /**
   * @api {post} /bookmarks.remove Remove bookmark of the page
   * @apiName RemoveBookmark
   * @apiGroup Bookmark
   *
   * @apiParam {String} page_id Page Id.
   */
  actions.api.remove = function(req: Request, res: Response) {
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
