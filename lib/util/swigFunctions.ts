import Crowi from 'server/crowi'
import { Express, Request, Response } from 'express'
import * as Icons from '@mdi/js'
import renderIcon from 'common/functions/renderIcon'
import { parentPath, isUserPageList, isUserPage, isTopPage, isTrashPage, userPageRoot, getAppContext } from './view'
import { hasSlackToken, googleLoginEnabled, githubLoginEnabled } from 'server/models/config'
import { UserStatus } from 'server/models/user'
import { PageGrant } from 'server/models/page'

export default (crowi: Crowi, app: Express, req: Request, res: Response) => {
  // const debug = Debug('crowi:lib:swigFunctions')
  const Page = crowi.model('Page')
  const Config = crowi.model('Config')
  const User = crowi.model('User')
  const { locals } = res

  // token getter
  locals.csrf = function () {
    return req.csrfToken
  }

  locals.assets = function (file) {
    // tmp
    return file
  }

  locals.googleLoginEnabled = function () {
    const config = crowi.getConfig()
    return googleLoginEnabled(config)
  }

  locals.githubLoginEnabled = function () {
    const config = crowi.getConfig()
    return githubLoginEnabled(config)
  }

  locals.searchConfigured = function () {
    if (crowi.getSearcher()) {
      return true
    }
    return false
  }

  locals.slackConfigured = function () {
    const config = crowi.getConfig()
    if (hasSlackToken(config)) {
      return true
    }
    return false
  }

  locals.isUploadable = function () {
    const config = crowi.getConfig()
    return Config.isUploadable(config)
  }

  locals.isExternalShareEnabled = function () {
    const config = crowi.getConfig()
    return config.crowi['app:externalShare']
  }

  locals.parentPath = parentPath

  locals.isUserPageList = isUserPageList

  locals.isUserPage = isUserPage

  locals.isTopPage = () => isTopPage(req.path || '')

  locals.isTrashPage = () => isTrashPage(req.path || '')

  locals.isDeletablePage = function () {
    const Page = crowi.model('Page')
    const path = req.path || ''

    return Page.isDeletableName(path)
  }

  locals.userPageRoot = userPageRoot

  locals.css = {
    grant: function (pageData) {
      if (!pageData) {
        return ''
      }

      switch (pageData.grant) {
        case PageGrant.Public:
          return 'grant-public'
        case PageGrant.Restricted:
          return 'grant-restricted'
        // case Page.GRANT_SPECIFIED:
        //  return 'grant-specified';
        //  break;
        case PageGrant.Owner:
          return 'grant-owner'
        default:
          break
      }
      return ''
    },
    userStatus: function (user) {
      // debug('userStatus', user._id, user.usename, user.status);

      switch (user.status) {
        case UserStatus.Registered:
          return 'badge-info'
        case UserStatus.Active:
          return 'badge-success'
        case UserStatus.Suspended:
          return 'badge-warning'
        case UserStatus.Deleted:
          return 'badge-danger'
        case UserStatus.Invited:
          return 'badge-info'
        default:
          break
      }
      return ''
    },
  }

  locals.Icon = function (name, classNames = [], attributes = '') {
    const key = `mdi${name.charAt(0).toUpperCase() + name.slice(1)}`
    const path = Icons[key]
    if (!(key in Icons)) {
      console.error(`${key} is not found.`)
    }
    return renderIcon(path, classNames, attributes)
  }

  locals.appContext = () => getAppContext(crowi, req)
}
