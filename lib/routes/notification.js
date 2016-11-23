module.exports = function(crowi, app) {
  'use strict';

  var debug = require('debug')('crowi:routes:notification')
    , Notification = crowi.model('Notification')
    , Page = crowi.model('Page')
    , User = crowi.model('User')
    , ApiResponse = require('../util/apiResponse')
    , actions = {}
  ;
  actions.api = {};

  // /**
  //  * @api {post} /notifications.add Add Notification
  //  * @apiName AddNotification
  //  * @apiGroup Notification
  //  *
  //  * //@apiParam {String} page_id Page Id.
  //  */
  // actions.api.add = function(req, res) {
  //   var pageId = req.body.page_id;
  //   var user = req.user;

  //   console.log(user);
  //   return {status: 'ok'};
  // };

  actions.notificationPage = function(req, res) {
    return res.render('notification', {

    });
  };

  /**
   * @api {get} /notifications.get Get Notifications List
   * @apiName ListNotifications
   * @apiGroup Notification
   *
   * // @apiParam {String}
   */
  actions.api.list = function(req, res) {
    const user = req.user;

    Notification
      .findLatestNotificationsByUser(user)
      .then(function(notifications) {
        const result = {
          notifications: notifications
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

  return actions;
};
