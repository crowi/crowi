import ReactDOMServer from 'react-dom/server'
import * as SSR from 'common/ssr'

export default res => (componentId: string, baseProps) => {
  if (SSR.hasComponent(componentId)) {
    const id = `ssr-${res.locals.ssr_id++}`
    const props = { ...baseProps, id }

    res.locals.ssr_context.push({ componentId, props })

    return ReactDOMServer.renderToString(SSR.createElement(componentId, props))
  }
}
