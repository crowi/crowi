module.exports = function(crowi, app) {
  'use strict'

  const url = require('url')
  const { slack } = crowi
  const Page = crowi.model('Page')
  const User = crowi.model('User')

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

  async function unfurl(req, res) {
    const { event } = req.body
    const { links, channel, message_ts: ts } = event
    const link = links[0]
    const { pathname, query } = url.parse(link.url, true)
    const pagePath = decodeURIComponent(pathname) || null
    const revisionId = query.revision_id || null

    try {
      const users = await User.findAllUsers()
      const pageData = await Page.findPage(pagePath, users[0], revisionId)
      const unfurls = {
        [link.url]: {
          title: pageData.path,
          text: slack.prepareAttachmentTextForCreate(pageData),
        },
      }

      await slack.unfurl(channel, unfurls, ts)

      res.sendStatus(200)
    } catch (err) {
      console.error('failed to unfurl link: ' + err)
      res.sendStatus(404)
    }
  }

  return actions
}
