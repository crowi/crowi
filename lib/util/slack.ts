import Crowi from 'server/crowi'
import Debug from 'debug'
import { WebClient as SlackWebClient } from '@slack/client'
import diff from 'diff'

const debug = Debug('crowi:util:slack')

export default (crowi: Crowi) => {
  const SLACK_URL = 'https://slack.com'

  const Config = crowi.model('Config')
  const slack: any = {}

  slack.client = undefined

  // get client with access token,
  // if access token is not fetched, return undefiend
  slack.getClient = function() {
    // alreay created
    if (slack.client) {
      return slack.client
    }

    const config = crowi.getConfig()

    let client
    if (Config.hasSlackToken(config)) {
      client = new SlackWebClient(config.notification['slack:token'])
      slack.client = client
    }

    return slack.client
  }

  // this is called to generate redirect_uri
  slack.getSlackAuthCallbackUrl = function() {
    const config = crowi.getConfig()
    // Web アクセスがきてないと app:url がセットされないので crowi.setupSlack 時にはできない
    // cli, bot 系作るときに問題なりそう
    return (config.crowi['app:url'] || '') + '/admin/notification/slackAuth'
  }

  // this is called to get the url for oauth screen
  slack.getAuthorizeURL = function() {
    const config = crowi.getConfig()
    if (Config.hasSlackConfig(config)) {
      const slackClientId = config.notification['slack:clientId']
      const redirectUri = slack.getSlackAuthCallbackUrl()
      const scope = ['chat:write:bot', 'links:write', 'links:read'].join(',')

      return `${SLACK_URL}/oauth/authorize?client_id=${slackClientId}&redirect_uri=${redirectUri}&scope=${scope}`
    } else {
      return ''
    }
  }

  // this is called to get access token with code (oauth process)
  slack.getOauthAccessToken = async function(code) {
    const client = new SlackWebClient()

    const config = crowi.getConfig()
    const clientId = config.notification['slack:clientId']
    const clientSecret = config.notification['slack:clientSecret']
    const redirectUri = slack.getSlackAuthCallbackUrl()

    const response = (await client.oauth.access({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      redirect_uri: redirectUri,
    })) as any

    if (!response.access_token) {
      debug('Error response', response)
      throw new Error(`Failed to fetch access_token from slack`)
    }

    return response.access_token
  }

  slack.post = function(channel, text, message) {
    const client = slack.getClient()

    return new Promise(function(resolve, reject) {
      client.chat
        .postMessage({ channel, text, ...message })
        .then(res => {
          resolve(res)
        })
        .catch(err => {
          debug('Post error', err)
          debug('Sent data to slack is:', message)
          return reject(err)
        })
    })
  }

  slack.convertMarkdownToMrkdwn = function(body) {
    const config = crowi.getConfig()
    let url = ''
    if (config.crowi && config.crowi['app:url']) {
      url = config.crowi['app:url']
    }

    body = body
      .replace(/\n\*\s(.+)/g, '\n• $1')
      .replace(/#{1,}\s?(.+)/g, '\n*$1*')
      .replace(/(\[(.+)\]\((https?:\/\/.+)\))/g, '<$3|$2>')
      .replace(/(\[(.+)\]\((\/.+)\))/g, '<' + url + '$3|$2>')

    return body
  }

  slack.prepareAttachmentTextForCreate = function(page, user) {
    let body = page.revision.body
    if (body.length > 2000) {
      body = body.substr(0, 2000) + '...'
    }

    return this.convertMarkdownToMrkdwn(body)
  }

  slack.prepareAttachmentTextForUpdate = function(page, user, previousRevision) {
    let diffText = ''

    diff.diffLines(previousRevision.body, page.revision.body).forEach(function(line) {
      debug('diff line', line)
      line.value.replace(/\r\n|\r/g, '\n')
      if (line.added) {
        diffText += `':pencil2: ...\n${line.value}`
      } else if (line.removed) {
        // diffText += '-' + line.value.replace(/(.+)?\n/g, '- $1\n');
        // 1以下は無視
        if (line.count && line.count > 1) {
          diffText += `':wastebasket: ... ${line.count} lines\n`
        }
      } else {
        // diffText += '...\n';
      }
    })

    debug('diff is', diffText)

    return diffText
  }

  slack.prepareSlackMessage = function(page, user, channel, updateType, previousRevision) {
    const config = crowi.getConfig()
    const url = config.crowi['app:url'] || ''
    let body = page.revision.body

    if (updateType == 'create') {
      body = this.prepareAttachmentTextForCreate(page, user)
    } else {
      body = this.prepareAttachmentTextForUpdate(page, user, previousRevision)
    }

    const attachment = {
      color: '#263a3c',
      author_name: '@' + user.username,
      author_link: url + '/user/' + user.username,
      author_icon: user.image,
      title: page.path,
      title_link: url + '/' + page._id,
      text: body,
      mrkdwn_in: ['text'],
    }
    if (user.image) {
      attachment.author_icon = user.image
    }

    const message = {
      channel: '#' + channel,
      username: 'Crowi',
      text: this.getSlackMessageText(page, user, updateType),
      attachments: [attachment],
    }

    return message
  }

  slack.getSlackMessageText = function(page, user, updateType) {
    let text
    const config = crowi.getConfig()
    const url = config.crowi['app:url'] || ''

    const pageLink = `<${url}/${page._id}|${page.path}>`
    if (updateType == 'create') {
      text = `:white_check_mark: ${user.username} created a new page! ${pageLink}`
    } else {
      text = `:up: ${user.username} updated ${pageLink}`
    }

    return text
  }

  slack.unfurl = function(channel, unfurls, ts) {
    const client = slack.getClient()

    return client.chat.unfurl({ ts, channel, unfurls })
  }

  return slack
}
