import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import ApiResponse from '../utils/apiResponse'
import { UserDocument } from 'server/models/user'

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:routes:notification')
  const Notification = crowi.model('Notification')
  const actions = {} as any
  actions.api = {} as any

  /**
   * @api {get} /notifications.list
   * @apiName ListNotifications
   * @apiGroup Notification
   *
   * @apiParam {String} linit
   */
  actions.api.list = function(req: Request, res: Response) {
    const user = req.user as UserDocument

    let limit = 10
    if (req.query.limit) {
      limit = parseInt(req.query.limit, 10)
    }

    let offset = 0
    if (req.query.offset) {
      offset = parseInt(req.query.offset, 10)
    }

    const requestLimit = limit + 1

    Notification.findLatestNotificationsByUser(user._id, requestLimit, offset)
      .then(function(notifications) {
        let hasPrev = false
        if (offset > 0) {
          hasPrev = true
        }

        let hasNext = false
        if (notifications.length > limit) {
          hasNext = true
        }

        const result = {
          notifications: notifications.slice(0, limit),
          hasPrev: hasPrev,
          hasNext: hasNext,
        }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  actions.api.read = function(req: Request, res: Response) {
    const user = req.user as UserDocument

    try {
      const notification = Notification.read(user)
      const result = { notification }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  actions.api.open = async function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const id = req.body.id

    try {
      const notification = await Notification.open(user, id)
      const result = { notification }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  actions.api.status = async function(req: Request, res: Response) {
    const user = req.user as UserDocument

    try {
      const count = await Notification.getUnreadCountByUser(user._id)
      const result = { count }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
