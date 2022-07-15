import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Crowi from 'server/crowi'

export const expressReactViewEngine = () => {
  return (path: string, props: object, callback: (e: any, rendered: string) => void): void => {
    const filePath = path.match(/.+\.(tsx|js)$/) ? path : Crowi.isRunOnTsNode() ? `${path}.tsx` : `${path}.js`

    try {
      console.log('to be load', filePath)
      let component = require(filePath)
      component = component.default || component as React.ComponentType<any>
      console.log('loaded comopnent', component)
      const markup = renderToStaticMarkup(createElement(component, props))
      return callback(null, `<!doctype html>${markup}`)
    } catch (e) {
      console.error('load error', e)
      return callback(e, '')
    }
  }
}
