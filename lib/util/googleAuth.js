/**
 * googleAuth utility
 */

module.exports = function(config) {
  'use strict'

  const lib = {}
  const auth = require('./auth')
  const { google: googleApis } = require('googleapis')
  const debug = require('debug')('crowi:lib:googleAuth')

  lib.PROVIDER = 'google'

  function createOauth2Client() {
    return new googleApis.auth.OAuth2(config.crowi['google:clientId'], config.crowi['google:clientSecret'], config.crowi['app:url'] + '/google/callback')
  }

  lib.createAuthUrl = function(req, callback) {
    const oauth2Client = createOauth2Client()
    googleApis.options({ auth: oauth2Client })

    var redirectUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['profile', 'email'],
      prompt: 'consent',
    })

    callback(null, redirectUrl)
  }

  lib.refreshAccessToken = async tokens => {
    const oauth2Client = createOauth2Client()
    googleApis.options({ auth: oauth2Client })
    oauth2Client.setCredentials({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken })
    const {
      res: {
        data: { access_token: accessToken, refresh_token: refreshToken, expiry_date: expiryDate },
      },
    } = await oauth2Client.refreshAccessToken()
    return { accessToken, refreshToken, expiryDate }
  }

  lib.reauth = async (id, { accessToken, refreshToken }) => {
    try {
      const tokens = await lib.refreshAccessToken({ accessToken, refreshToken })
      console.log({ tokens })
      const oauth2Client = createOauth2Client()
      googleApis.options({ auth: oauth2Client })
      oauth2Client.setCredentials({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken })
      const {
        data: { user_id: userId },
      } = await googleApis.oauth2('v2').tokeninfo({ access_token: tokens.accessToken })
      const success = id === userId
      return { success, tokens }
    } catch (err) {
      debug('Error on reauthenticating', err)
      return { success: false }
    }
  }

  lib.handleCallback = function(req, callback) {
    const oauth2Client = createOauth2Client()
    googleApis.options({ auth: oauth2Client })
    const { google = {} } = req.session
    const { authCode: code } = google

    if (!code) {
      return callback(new Error('No code exists.'), null)
    }

    debug('Request googleToken by auth code', code)
    oauth2Client.getToken(code, function(err, tokens) {
      debug('Result of google.getToken()', err, tokens)
      if (err) {
        return callback(new Error('[googleAuth.handleCallback] Error to get token.'), null)
      }

      oauth2Client.setCredentials({
        access_token: tokens.access_token,
      })

      const oauth2 = googleApis.oauth2('v2')
      oauth2.userinfo.get({}, function(err, response) {
        debug('Response of oauth2.userinfo.get', err, response)
        if (err) {
          return callback(new Error('[googleAuth.handleCallback] Error while proceccing userinfo.get.'), null)
        }
        const { access_token: accessToken, refresh_token: refreshToken, expiry_date: expiryDate } = tokens
        auth.saveTokenToSession(req, lib.PROVIDER, { accessToken, refreshToken, expiryDate })
        const { data } = response
        data.user_id = data.id // This is for B.C. (tokeninfo をつかっている前提のコードに対してのもの)
        return callback(null, data)
      })
    })
  }

  return lib
}
