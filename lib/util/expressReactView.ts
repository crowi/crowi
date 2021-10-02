import { createElement } from "react"
import { renderToStaticMarkup } from 'react-dom/server'
import Crowi from "server/crowi"

export const expressReactViewEngine = () => {
  return (path: string, props: object, callback: (e: any, rendered: string) => void): void => {
    const filePath = path.match(/.+\.(tsx|js)$/)
      ? path
      : (Crowi.isRunOnTsNode() ? `${path}.tsx` : `${path}.js`)

    try {
      const component = require(filePath).default as React.ComponentType<any>
      const markup = renderToStaticMarkup(
        createElement(component, props)
      )
      return callback(null, `<!doctype html>${markup}`);
    } catch (e) {
      return callback(e, '')
    }
  }
}