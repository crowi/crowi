import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import url from 'url'

export default (crowi: Crowi) => {
  const debug = Debug('crowi:routes:slack')
  const { slack } = crowi
  const Page = crowi.model('Page')

  const actions = {} as any
  const api = (actions.api = {} as any)

  api.handleEvent = function(req: Request, res: Response) {
    if (req.body.type != null && req.body.type == 'url_verification') {
      verifyChallenge(req, res)
      return
    }

    const { type } = req.body.event
    switch (type) {
      case 'link_shared':
        unfurl(req, res)
        break
      default:
        break
    }
  }

  function verifyChallenge(req: Request, res: Response) {
    res.send(req.body.challenge)
  }

  function parseLink(link) {
    const { pathname, query } = url.parse(link, true)
    const pagePath = (pathname && decodeURIComponent(pathname)) || null
    const revisionId = query.revision || null
    return { pagePath, revisionId }
  }

  function parseLinks(links) {
    const results = {}
    links.forEach(({ url }) => {
      const { pagePath, revisionId } = parseLink(url)
      if (pagePath) {
        results[pagePath] = { url, pagePath, revisionId }
      }
    })
    return results
  }

  async function unfurl(req: Request, res: Response) {
    const { event } = req.body
    const { links, channel, message_ts: ts } = event
    const results = parseLinks(links)
    const keys = Object.keys(results)

    const isObjectId = key => new RegExp('/([0-9a-fA-F]{24})').test(key)
    const extractObjectId = key => (isObjectId(key) ? RegExp.$1 : null)
    const isCreatablePath = key => Page.isCreatableName(key)

    const pageIds = keys.map(extractObjectId).filter(key => key !== null)
    const pagePaths = keys.filter(isCreatablePath)

    const getResult = ({ _id, path }) => (_id && results[`/${_id}`]) || (path && results[path])

    try {
      const pagesById = await Page.findUnfurlablePagesByIds(pageIds)
      const pagesByPaths = await Page.findUnfurlablePagesByPaths(pagePaths)
      const pages = [...pagesById, ...pagesByPaths]

      if (pages.length === 0) {
        const pageNotFoundError = new Error('Page Not Found')
        pageNotFoundError.name = 'Crowi:Page:NotFound'
        throw pageNotFoundError
      }

      const revisionIds = pages.map(page => getResult(page).revisionId)
      const pagesData = await Page.populatePagesRevision(pages, revisionIds)

      const unfurls = {}
      pagesData.forEach(page => {
        const { url } = getResult(page)
        const { path: title } = page
        const text = slack.prepareAttachmentTextForCreate(page)
        unfurls[url] = { title, text }
      })

      await slack.unfurl(channel, unfurls, ts)

      res.sendStatus(200)
    } catch (err) {
      debug('Failed to unfurl link:', err)
      res.sendStatus(404)
    }
  }

  return actions
}
