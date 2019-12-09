import ReactDOMServer from 'react-dom/server'
import * as SSR from 'common/ssr'
import { AppContext } from 'server/types/appContext'
import Crowi from 'server/crowi'

export const renderComponent = res => (componentId: string, baseProps) => {
  if (SSR.hasComponent(componentId)) {
    const id = `ssr-${res.locals.ssr_id++}`
    const props = { ...baseProps, id }

    res.locals.ssr_context.push({ componentId, props })

    return ReactDOMServer.renderToString(SSR.createElement(componentId, props))
  }
}

export const getPath = (crowi: Crowi, path: string) => (crowi.node_env === 'development' ? `${path}.tsx` : `${path}.js`)

export const getContext = (crowi: Crowi, req, res) => {
  const config = req.config
  const env = crowi.getEnv()
  const Config = crowi.model('Config')

  return {
    title: (config.crowi['app:title'] || 'Crowi') as AppContext['title'],
    path: req.path || '',
    upload: {
      image: Config.isUploadable(config),
      file: Config.fileUploadEnabled(config),
    },
    search: {
      isConfigured: !!crowi.getSearcher(),
    },
    user: (req.user || null) as AppContext['user'],
    env: {
      PLANTUML_URI: env.PLANTUML_URI || null,
      MATHJAX: env.MATHJAX || null,
    },
    config: {
      crowi: config.crowi,
    },
    csrfToken: req.csrfToken as AppContext['csrfToken'],
    hydrated: {
      local: JSON.stringify(res.locals.local_config),
      user: JSON.stringify(res.locals.user_context),
      ssr: JSON.stringify(res.locals.ssr_context),
    },
  }
}

// FIXME: Use webpack mainfest in production
export const assetPath = (path: string) => path
