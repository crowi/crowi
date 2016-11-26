module.exports = function(crowi, app) {
  'use strict';

  var debug = require('debug')('crowi:routes:notification')
    , Notification = crowi.model('Notification')
    , NotificationStatus = crowi.model('NotificationStatus')
    , Page = crowi.model('Page')
    , User = crowi.model('User')
    , ApiResponse = require('../util/apiResponse')
    , actions = {}
  ;
  actions.api = {};

  actions.notificationPage = function(req, res) {
    return res.render('notification', {

    });
  };

  /**
   * @api {get} /notifications.list
   * @apiName ListNotifications
   * @apiGroup Notification
   *
   * @apiParam {String} linit
   */
  actions.api.list = function(req, res) {
    const user = req.user;

    let limit = 10;
    if (req.query.limit) {
      limit = parseInt(req.query.limit, 10);
    }

    let offset = 0;
    if (req.query.offset) {
      offset = parseInt(req.query.offset, 10);
    }

    const requestLimit = limit + 1;

    Notification
      .findLatestNotificationsByUser(user, requestLimit, offset)
      .then(function(notifications) {
        let hasPrev = false;
        if (offset > 0) {
          hasPrev = true;
        }

        let hasNext = false;
        if (notifications.length > limit) {
          hasNext = true;
        }

        const result = {
          notifications: notifications.slice(0, limit),
          hasPrev: hasPrev,
          hasNext: hasNext,
        };

        return res.json(ApiResponse.success(result));
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err));
      })
    ;
  };

  actions.api.read = function(req, res) {
    const user = req.user;
    const id = req.body.params.id;

    Notification
      .read(user, id)
      .then(function(notification) {
        const result = {
          notification: notification,
        };

        return res.json(ApiResponse.success(result));
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err));
      });
  };

  actions.api.status = function(req, res) {
    const user = req.user;

    NotificationStatus
      .findByUser(user)
      .then(function(notificationStatus) {
        const result = {
          status: notificationStatus,
        };
        return res.json(ApiResponse.success(result));
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err));
      })
    ;
  };

  actions.api.statusRead = function(req, res) {
    const user = req.user;

    NotificationStatus
      .updateIsReadFlag(user, true)
      .then(function(notificationStatus) {
        const result = {
          status: notificationStatus,
        };
        return res.json(ApiResponse.success(result));
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err));
      });
    ;
  };

  return actions;
};
