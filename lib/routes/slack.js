module.exports = function(crowi, app) {
  'use strict'

  const url = require('url')
  const { slack } = crowi
  const Page = crowi.model('Page')

  const actions = {}
  const api = (actions.api = {})

  api.handleEvent = function(req, res) {
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

  function verifyChallenge(req, res) {
    res.send(req.body.challenge)
  }

  function parseLink(link) {
    const { pathname, query } = url.parse(link, true)
    const pagePath = decodeURIComponent(pathname) || null
    const revisionId = query.revision || null
    return { pagePath, revisionId }
  }

  function parseLinks(links) {
    const results = {}
    links.forEach(({ url }) => {
      const { pagePath, revisionId } = parseLink(url)
      results[pagePath] = { url, pagePath, revisionId }
    })
    return results
  }

  async function unfurl(req, res) {
    const { event } = req.body
    const { links, channel, message_ts: ts } = event
    const results = parseLinks(links)
    const pagePaths = Object.keys(results)

    try {
      const pages = await Page.findUnfurlablePages(pagePaths)
      const revisionIds = pages.map(page => page.path).map(path => results[path].revisionId)
      const revisionIds = pages.map(({ path }) => results[path].revision)
      const revisionIds = pages.map(({ path }) => results[path].revisionId)
      const pagesData = await Page.populatePagesRevision(pages, revisionIds)

      const unfurls = {}
      pagesData.forEach(page => {
        const { path } = page
        const { url, pagePath: title } = results[path]
        const text = slack.prepareAttachmentTextForCreate(page)
        unfurls[url] = { title, text }
      })

      await slack.unfurl(channel, unfurls, ts)

      res.sendStatus(200)
    } catch (err) {
      console.error('failed to unfurl link: ' + err)
      res.sendStatus(404)
    }
  }

  return actions
}
