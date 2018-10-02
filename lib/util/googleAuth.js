/**
 * googleAuth utility
 */

module.exports = function(config) {
  'use strict'

  const { google: googleApis } = require('googleapis')
  const debug = require('debug')('crowi:lib:googleAuth')
  const lib = {}

  function createOauth2Client() {
    const clientId = config.crowi['google:clientId']
    const clientSecret = config.crowi['google:clientSecret']
    const callbackUrl = config.crowi['app:url'] + '/google/callback'
    return new googleApis.auth.OAuth2(clientId, clientSecret, callbackUrl)
  }

  lib.createAuthUrl = function(req, callback) {
    const oauth2Client = createOauth2Client()
    googleApis.options({ auth: oauth2Client })

    const redirectUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['profile', 'email'],
      state: req.query.continue,
    })

    callback(null, redirectUrl)
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
        const { data } = response
        data.user_id = data.id // This is for B.C. (tokeninfo をつかっている前提のコードに対してのもの)
        return callback(null, data)
      })
    })
  }

  return lib
}
