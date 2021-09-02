import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import ApiResponse from 'server/util/apiResponse'
import { UserDocument } from 'server/models/user'

export default (crowi: Crowi) => {
  const User = crowi.model('User')
  const Page = crowi.model('Page')
  const actions = {} as any
  const api = {} as any

  actions.api = api

  api.checkUsername = function (req: Request, res: Response) {
    const username = req.query.username

    User.findUserByUsername(username)
      .then(function (userData) {
        if (userData) {
          return res.json({ valid: false })
        } else {
          return res.json({ valid: true })
        }
      })
      .catch(function (err) {
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
  api.list = function (req: Request, res: Response) {
    const userIds = (req.query.user_ids as string) || null // TODO: handling

    let userFetcher
    if (!userIds || userIds.split(',').length <= 0) {
      userFetcher = User.findAllUsers()
    } else {
      userFetcher = User.findUsersByIds(userIds.split(','))
    }

    userFetcher
      .then(function (userList) {
        const result = {
          users: userList,
        }

        return res.json(ApiResponse.success(result))
      })
      .catch(function (err) {
        return res.json(ApiResponse.error(err))
      })
  }

  api.getRecentlyViewedPages = async function (req: Request, res: Response) {
    const user = req.user as UserDocument
    const pageIds = await crowi.lru.get(user._id.toString(), 10)
    let pages = await Page.findPagesByIds(pageIds)
    pages = pages.sort((a, b) => pageIds.indexOf(a._id.toString()) - pageIds.indexOf(b._id.toString()))
    pages = pages.filter(({ path }) => path !== '/')
    pages = pages.slice(0, 5)
    return res.json(ApiResponse.success({ pages }))
  }

  return actions
}
