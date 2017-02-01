module.exports = function(crowi, app) {
  'use strict';

  var debug = require('debug')('crowi:routes:backlink')
    , Backlink = crowi.model('Backlink')
    , ApiResponse = require('../util/apiResponse')
    , actions = {}
  ;
  actions.api = {};

  /**
   * @api {list} /backlink.list Get list backlinks of the page
   * @apiName ListBackLink
   * @apiGroup Backlink
   *
   * @apiParam {String} page_id Page Id.
   * @apiParam {Number} limit
   * @apiParam {Number} offset
   */
  actions.api.list = function (req, res) {
    var pageId = req.query.page_id;
    var limit  = req.query.limit || 10;
    var offset = req.query.offset || 0;

    Backlink
      .findByPageId(pageId, limit, offset)
      .then((backlinks) => {
        var result = {
          data: backlinks,
        };
        return res.json(ApiResponse.success(result));
      })
      .catch((err) => {
        return res.json(ApiResponse.error(err));
      });
  };

  return actions;
};
