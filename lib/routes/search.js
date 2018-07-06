module.exports = function(crowi, app) {
  'use strict'

  // var debug = require('debug')('crowi:routes:search')
  var Page = crowi.model('Page')
  var ApiResponse = require('../util/apiResponse')
  var ApiPaginate = require('../util/apiPaginate')
  var actions = {}
  var api = (actions.api = {})

  actions.searchPage = function(req, res) {
    var keyword = req.query.q || null
    var search = crowi.getSearcher()
    if (!search) {
      return res.json(ApiResponse.error('Configuration of ELASTICSEARCH_URI is required.'))
    }

    return res.render('search', {
      q: keyword,
    })
  }

  /**
   * @api {get} /search search page
   * @apiName Search
   * @apiGroup Search
   *
   * @apiParam {String} q keyword
   * @apiParam {String} path
   * @apiParam {String} offset
   * @apiParam {String} limit
   */
  api.search = function(req, res) {
    var keyword = req.query.q || null
    var tree = req.query.tree || null
    var paginateOpts

    try {
      paginateOpts = ApiPaginate.parseOptionsForElasticSearch(req.query)
    } catch (e) {
      res.json(ApiResponse.error(e))
    }

    if (keyword === null || keyword === '') {
      return res.json(ApiResponse.error('keyword should not empty.'))
    }

    var search = crowi.getSearcher()
    if (!search) {
      return res.json(ApiResponse.error('Configuration of ELASTICSEARCH_URI is required.'))
    }

    var searchOpts = Object.assign({}, paginateOpts)
    var doSearch
    if (tree) {
      doSearch = search.searchKeywordUnderPath(keyword, tree, searchOpts)
    } else {
      doSearch = search.searchKeyword(keyword, searchOpts)
    }
    var result = {}
    doSearch
      .then(function(data) {
        result.meta = data.meta

        return Page.populatePageListToAnyObjects(data.data)
      })
      .then(function(pages) {
        result.data = pages.filter(function(page) {
          if (Object.keys(page).length < 12) {
            // FIXME: 12 is a number of columns.
            return false
          }
          return true
        })
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  return actions
}
