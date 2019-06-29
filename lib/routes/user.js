module.exports = function(crowi, app) {
  'use strict'

  const User = crowi.model('User')
  const Bookmark = crowi.model('Bookmark')
  const Page = crowi.model('Page')
  const ApiResponse = require('../util/apiResponse')
  const actions = {}
  const api = {}

  actions.api = api

  api.bookmarks = function(req, res) {
    var options = {
      skip: req.query.offset || 0,
      limit: req.query.limit || 50,
    }
    Bookmark.findByUser(req.user, options, function(err, bookmarks) {
      res.json(bookmarks)
    })
  }

  api.checkUsername = function(req, res) {
    var username = req.query.username

    User.findUserByUsername(username)
      .then(function(userData) {
        if (userData) {
          return res.json({ valid: false })
        } else {
          return res.json({ valid: true })
        }
      })
      .catch(function(err) {
        return res.json({ valid: true })
      })
  }

  /**
   * @api {get} /users.list Get user list
   * @apiName GetUserList
   * @apiGroup User
   *
   * @apiParam {String} user_ids
   */
  api.list = function(req, res) {
    var userIds = req.query.user_ids || null // TODO: handling

    var userFetcher
    if (!userIds || userIds.split(',').length <= 0) {
      userFetcher = User.findAllUsers()
    } else {
      userFetcher = User.findUsersByIds(userIds.split(','))
    }

    userFetcher
      .then(function(userList) {
        var result = {
          users: userList,
        }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  api.getRecentlyViewedPages = async function(req, res) {
    const pageIds = await crowi.lru.get(req.user._id.toString(), 10)
    let pages = await Page.findPagesByIds(pageIds)
    pages = pages.sort((a, b) => pageIds.indexOf(a._id.toString()) - pageIds.indexOf(b._id.toString()))
    pages = pages.filter(({ path }) => path !== '/')
    pages = pages.slice(0, 5)
    return res.json(ApiResponse.success({ pages }))
  }

  return actions
}
