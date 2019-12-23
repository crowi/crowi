import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import ApiResponse from '../utils/apiResponse'
import ApiPaginate from '../utils/apiPaginate'
import { getPath } from 'server/utils/ssr'
import { getAppContext } from 'server/utils/view'
import Debug from 'debug'

const debug = Debug('crowi:routes:search')

export default (crowi: Crowi) => {
  const Page = crowi.model('Page')
  const actions = {} as any
  const api = (actions.api = {} as any)

  actions.searchPage = function(req: Request, res: Response) {
    const search = crowi.getSearcher()
    if (!search) {
      return res.json(ApiResponse.error('Configuration of ELASTICSEARCH_URI is required.'))
    }

    return res.render(getPath(crowi, 'SearchPage'), { i18n: req.i18n, context: getAppContext(crowi, req) })
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
  api.search = async function(req: Request, res: Response) {
    const { user } = req
    const { q: keyword = null, tree = null, type = null } = req.query
    let paginateOpts

    try {
      paginateOpts = ApiPaginate.parseOptionsForElasticSearch(req.query)
    } catch (e) {
      res.json(ApiResponse.error(e))
    }

    if (keyword === null || keyword === '') {
      return res.json(ApiResponse.error('keyword should not empty.'))
    }

    const search = crowi.getSearcher()
    if (!search) {
      return res.json(ApiResponse.error('Configuration of ELASTICSEARCH_URI is required.'))
    }

    const searchOpts = { ...paginateOpts, type }
    let doSearch
    if (tree) {
      doSearch = search.searchKeywordUnderPath(keyword, tree, user, searchOpts)
    } else {
      doSearch = search.searchKeyword(keyword, user, searchOpts)
    }

    try {
      const { meta, data: searchResult } = await doSearch

      const pages = await Page.populatePageListToAnyObjects(searchResult)

      const data = pages
        .filter(page => {
          if (Object.keys(page).length < 12) {
            // FIXME: 12 is a number of columns.
            return false
          }
          return true
        })
        .map(page => {
          return { ...page, bookmarkCount: (page._source && page._source.bookmark_count) || 0 }
        })

      return res.json(ApiResponse.success({ meta, searchResult, data }))
    } catch (err) {
      debug('Error on searching:', err)
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
