import Crowi from 'server/crowi'
import { Express, Request, Response } from 'express'
import * as Icons from '@mdi/js'
import renderIcon from 'common/functions/renderIcon'
import { parentPath, isUserPageList, isUserPage, isTopPage, isTrashPage, userPageRoot, getAppContext } from './view'

export default (crowi: Crowi, app: Express, req: Request, res: Response) => {
  // const debug = Debug('crowi:lib:swigFunctions')
  const Page = crowi.model('Page')
  const Config = crowi.model('Config')
  const User = crowi.model('User')
  const { locals } = res

  // token getter
  locals.csrf = function() {
    return req.csrfToken
  }

  locals.assets = function(file) {
    // tmp
    return file
  }

  locals.googleLoginEnabled = function() {
    const config = crowi.getConfig()
    return Config.googleLoginEnabled(config)
  }

  locals.githubLoginEnabled = function() {
    const config = crowi.getConfig()
    return Config.githubLoginEnabled(config)
  }

  locals.searchConfigured = function() {
    if (crowi.getSearcher()) {
      return true
    }
    return false
  }

  locals.slackConfigured = function() {
    var config = crowi.getConfig()
    if (Config.hasSlackToken(config)) {
      return true
    }
    return false
  }

  locals.isUploadable = function() {
    var config = crowi.getConfig()
    return Config.isUploadable(config)
  }

  locals.isExternalShareEnabled = function() {
    var config = crowi.getConfig()
    return config.crowi['app:externalShare']
  }

  locals.parentPath = parentPath

  locals.isUserPageList = isUserPageList

  locals.isUserPage = isUserPage

  locals.isTopPage = () => isTopPage(req.path || '')

  locals.isTrashPage = () => isTrashPage(req.path || '')

  locals.isDeletablePage = function() {
    var Page = crowi.model('Page')
    var path = req.path || ''

    return Page.isDeletableName(path)
  }

  locals.userPageRoot = userPageRoot

  locals.css = {
    grant: function(pageData) {
      if (!pageData) {
        return ''
      }

      switch (pageData.grant) {
        case Page.GRANT_PUBLIC:
          return 'grant-public'
        case Page.GRANT_RESTRICTED:
          return 'grant-restricted'
        // case Page.GRANT_SPECIFIED:
        //  return 'grant-specified';
        //  break;
        case Page.GRANT_OWNER:
          return 'grant-owner'
        default:
          break
      }
      return ''
    },
    userStatus: function(user) {
      // debug('userStatus', user._id, user.usename, user.status);

      switch (user.status) {
        case User.STATUS_REGISTERED:
          return 'badge-info'
        case User.STATUS_ACTIVE:
          return 'badge-success'
        case User.STATUS_SUSPENDED:
          return 'badge-warning'
        case User.STATUS_DELETED:
          return 'badge-danger'
        case User.STATUS_INVITED:
          return 'badge-info'
        default:
          break
      }
      return ''
    },
  }

  locals.Icon = function(name, classNames = [], attributes = '') {
    const key = `mdi${name.charAt(0).toUpperCase() + name.slice(1)}`
    const path = Icons[key]
    if (!(key in Icons)) {
      console.error(`${key} is not found.`)
    }
    return renderIcon(path, classNames, attributes)
  }

  locals.appContext = () => getAppContext(crowi, req)
}
