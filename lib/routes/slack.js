module.exports = function(crowi, app) {
  'use strict'

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

  function unfurl(req, res) {
    const https = require('https')
    const HOST = 'slack.com'
    const PATH = '/api/chat.unfurl'

    const link = req.body.event.links[0]
    const channel = req.body.event.channel
    const url = require('url').parse(link.url, true)

    const pagePath = url.path || null
    const revisionId = url.query.revision_id || null

    User.findAllUsers()
      .then(function(users) {
        return Page.findPage(pagePath, users[0], revisionId)
      })
      .then(function(pageData) {
        const unfurls = {
          [link.url]: {
            title: pageData.path,
            text: slack.prepareAttachmentTextForCreate(pageData),
          },
        }

        const config = crowi.getConfig()
        const token = config.notification['slack:token']
        const postData = {
          token,
          channel,
          ts: req.body.event.message_ts,
          unfurls: encodeURIComponent(JSON.stringify(unfurls)),
        }

        const options = {
          host: HOST,
          port: 443,
          path: PATH + '?token=' + postData['token'] + '&channel=' + postData['channel'] + '&ts=' + postData['ts'] + '&unfurls=' + postData['unfurls'],
          method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=utf-8',
          },
        }

        const slackReq = https.request(options, slackRes => {
          slackRes.setEncoding('utf8')
        })
        slackReq.on('error', e => {
          console.error('failed to send a request to Slack: ' + e.message)
        })
        slackReq.end()
        res.sendStatus(200)
      })
      .catch(function(err) {
        console.error('failed in fetching page: ' + err)
        res.sendStatus(404)
      })
  }

  return actions
}
