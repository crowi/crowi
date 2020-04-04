import { Request, Response } from 'express'
import Debug from 'debug'
import auth from './auth'
import passport from 'passport'
import { Strategy as GitHubStrategy } from 'passport-github'
import { getContinueUrl } from './url'
import Octokit from '@octokit/rest'

const debug = Debug('crowi:lib:githubAuth')

export default config => {
  const lib: any = {}

  lib.PROVIDER = 'github'

  function useGitHubStrategy(config, callbackQuery = '') {
    passport.use(
      new GitHubStrategy(
        {
          clientID: config.crowi['github:clientId'],
          clientSecret: config.crowi['github:clientSecret'],
          callbackURL: `${config.crowi['app:url']}/github/callback${callbackQuery}`,
          scope: ['user:email', 'read:org'],
        },
        async (accessToken, refreshToken, profile, callback) => {
          debug('profile', profile)
          const octokit = new Octokit({ auth: accessToken })
          const { data: orgs } = await octokit.orgs.listForAuthenticatedUser()
          const orgNames = orgs.map(org => org.login)

          debug(orgNames)

          callback(null, {
            token: accessToken,
            user_id: profile.id,
            email: profile.emails.filter(v => v.primary)[0].value,
            name: profile.displayName || '',
            picture: profile.photos[0].value,
            organizations: orgNames,
          })
        },
      ),
    )
  }

  lib.authenticate = function(req: Request, res: Response, next) {
    const continueUrl = getContinueUrl(req)
    const query = continueUrl === '/' ? '' : `?continue=${continueUrl}`
    useGitHubStrategy(config, query)
    passport.authenticate('github')(req, res, next)
  }

  lib.getOrganization = () => {}

  lib.reauth = async function(id, { accessToken }) {
    try {
      const octokit = new Octokit({ auth: accessToken })
      const {
        data: { id: userId },
      } = await octokit.users.getAuthenticated()
      const { data: orgs } = await octokit.orgs.listForAuthenticatedUser()
      const orgNames = orgs.map(org => org.login)
      const organization = config.crowi['github:organization']
      const success = id === String(userId) && (!organization || orgNames.includes(organization))
      const tokens = { accessToken }
      return { success, tokens }
    } catch (err) {
      debug('Error on reauthenticating', err)
      return { success: false }
    }
  }

  lib.handleCallback = function(req: Request, res: Response, next) {
    return function(callback) {
      useGitHubStrategy(config)
      passport.authenticate('github', function(err, user, info) {
        if (err) {
          return callback(err, null)
        }

        auth.saveTokenToSession(req, lib.PROVIDER, { accessToken: user.token, refreshToken: null, expiryDate: null })
        return callback(err, user)
      })(req, res, next)
    }
  }

  return lib
}
