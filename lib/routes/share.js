module.exports = function(crowi, app) {
  'use strict';

  var debug = require('debug')('crowi:routes:page')
    , Page = crowi.model('Page')
    , User = crowi.model('User')
    , Revision = crowi.model('Revision')
    , Bookmark = crowi.model('Bookmark')
    , ApiResponse = require('../util/apiResponse')

    , sprintf = require('sprintf')

    , actions = {};

  function renderPage(pageData, req, res) {
    var renderVars = {
      path: pageData.path,
      page: pageData,
      revision: pageData.revision || {},
      author: pageData.revision.author || false,
    };

    Revision.findRevisionList(pageData.path, {})
    .then(function(tree) {
      renderVars.tree = tree;

      return Promise.resolve();
    }).then(function() {
      res.render('page_share', renderVars);
    }).catch(function(err) {
      debug('Error: renderPage()', err);
      if (err) {
        res.redirect('/');
      }
    });
  }

  actions.pageShow = function(req, res) {
    var id = req.params.id;

    Page.findPageById(id)
    .then(function(pageData) {
      return Promise.resolve(pageData);
    }).then(function(page) {
      return renderPage(page, req, res);
    }).catch(function(err) {
      console.log(err);
      return res.redirect('/');
    });
  };

  return actions;
};
