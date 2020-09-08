import Crowi from 'server/crowi'
import { AppContext } from 'server/types/appContext'
import { isRequiredThirdPartyAuth, isDisabledPasswordAuth, googleLoginEnabled, githubLoginEnabled } from 'server/models/config'

// Static functions related to view used by swig (functions and filters) and react

export const parentPath = (path: string) => {
  if (path === '/' || path.match(/.+\/$/)) {
    return path
  }

  return path + '/'
}

export const isUserPageList = (path: string) => /^\/user\/[^/]+\/$/.test(path) || /^\/user\/$/.test(path)

export const isUserPage = (path: string) => /^\/user\/[^/]+$/.test(path)

export const isTopPage = (path: string) => path === '/'

export const isTrashPage = (path: string) => /^\/trash\/.*/.test(path)

export const userPageRoot = (user) => {
  if (!user || !user.username) {
    return ''
  }
  return '/user/' + user.username
}

export const picture = (user) => {
  if (!user) {
    return ''
  }

  if (user.image && user.image != '/images/userpicture.png') {
    return user.image
  } else {
    return '/images/userpicture.png'
  }
}

const getUserContext = (req): AppContext['user'] => {
  const { _id = null, name = '', username = '', image = '', email = null, googleId = null, githubId = null, admin = false } = req.user || {}
  const { language = '' } = req.i18n || {}
  return {
    _id,
    name,
    username,
    image,
    email,
    googleId,
    githubId,
    admin,
    language,
  }
}

const getConfigContext = (config) => {
  const { crowi } = config || {}
  return {
    crowi: {
      'app:confidential': crowi['app:confidential'] || null,
    },
  }
}

export const getAppContext = (crowi: Crowi, req): AppContext => {
  const config = req.config
  const env = crowi.getEnv()
  const Config = crowi.model('Config')

  return {
    title: (config.crowi['app:title'] || 'Crowi') as AppContext['title'],
    path: req.path || '',
    url: config.crowi['app:url'] || '',
    auth: {
      requireThirdPartyAuth: isRequiredThirdPartyAuth(config),
      canDisconnectThirdPartyId: req.user ? req.user.canDisconnectThirdPartyId() : false,
      disablePasswordAuth: isDisabledPasswordAuth(config),
      providers: {
        google: googleLoginEnabled(config),
        github: githubLoginEnabled(config),
      },
    },
    upload: {
      image: Config.isUploadable(config),
      file: Config.fileUploadEnabled(config),
    },
    search: {
      isConfigured: !!crowi.getSearcher(),
    },
    security: {
      registrationWhiteList: config.crowi['security:registrationWhiteList'] || [],
    },
    user: getUserContext(req),
    env: {
      PLANTUML_URI: env.PLANTUML_URI || null,
      MATHJAX: env.MATHJAX || null,
    },
    config: getConfigContext(config),
    csrfToken: req.csrfToken as AppContext['csrfToken'],
  }
}
