module.exports = function(crowi, app) {
  'use strict'

  // const debug = require('debug')('crowi:routes:notification')
  const Notification = crowi.model('Notification')
  const ApiResponse = require('../util/apiResponse')
  const actions = {}
  actions.api = {}

  actions.notificationPage = function(req, res) {
    return res.render('notification', {})
  }

  /**
   * @api {get} /notifications.list
   * @apiName ListNotifications
   * @apiGroup Notification
   *
   * @apiParam {String} linit
   */
  actions.api.list = function(req, res) {
    const user = req.user

    let limit = 10
    if (req.query.limit) {
      limit = parseInt(req.query.limit, 10)
    }

    let offset = 0
    if (req.query.offset) {
      offset = parseInt(req.query.offset, 10)
    }

    const requestLimit = limit + 1

    Notification.findLatestNotificationsByUser(user, requestLimit, offset)
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

  actions.api.read = function(req, res) {
    const user = req.user

    try {
      const notification = Notification.read(user)
      const result = { notification }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  actions.api.open = async function(req, res) {
    const user = req.user
    const id = req.body.id

    try {
      const notification = await Notification.open(user, id)
      const result = { notification }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  actions.api.status = async function(req, res) {
    const user = req.user

    try {
      const count = await Notification.getUnreadCountByUser(user)
      const result = { count }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
