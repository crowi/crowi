/**
 * githubAuth utility
 */

module.exports = function(config) {
  'use strict'

  const lib = {}
  const auth = require('./auth')
  const passport = require('passport')
  const GitHubStrategy = require('passport-github').Strategy
  const debug = require('debug')('crowi:lib:githubAuth')
  const octokit = require('@octokit/rest')()

  lib.PROVIDER = 'github'

  function useGitHubStrategy(config) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: config.crowi['github:clientId'],
          clientSecret: config.crowi['github:clientSecret'],
          callbackURL: config.crowi['app:url'] + '/github/callback',
          scope: ['user:email', 'read:org'],
        },
        function(accessToken, refreshToken, profile, callback) {
          debug('profile', profile)
          octokit.authenticate({ type: 'oauth', token: accessToken })
          octokit.users
            .getOrgs({})
            .then(data => data.data.map(org => org.login))
            .then(orgs => {
              debug('crowi:orgs', orgs)
              callback(null, {
                token: accessToken,
                user_id: profile.id,
                email: profile.emails.filter(v => v.primary)[0].value,
                name: profile.displayName || '',
                picture: profile.photos[0].value,
                organizations: orgs,
              })
            })
        },
      ),
    )
  }

  lib.authenticate = function(req, res, next) {
    useGitHubStrategy(config)
    passport.authenticate('github')(req, res, next)
  }

  lib.getOrganization = () => {}

  lib.reauth = async function(id, { accessToken }) {
    try {
      octokit.authenticate({ type: 'oauth', token: accessToken })
      const {
        data: { id: userId },
      } = await octokit.users.get({})
      const { data = [] } = await octokit.users.getOrgs({})
      const orgs = data.map(org => org.login)
      const organization = config.crowi['github:organization']
      const success = id === String(userId) && (!organization || orgs.includes(organization))
      const tokens = { accessToken }
      return { success, tokens }
    } catch (err) {
      debug('Error on reauthenticating', err)
      return { success: false }
    }
  }

  lib.handleCallback = function(req, res, next) {
    return function(callback) {
      useGitHubStrategy(config)
      passport.authenticate('github', function(err, user, info) {
        if (err) {
          return callback(err, null)
        }
        auth.saveTokenToSession(req, lib.PROVIDER, { accessToken: user.token })
        return callback(err, user)
      })(req, res, next)
    }
  }

  return lib
}
