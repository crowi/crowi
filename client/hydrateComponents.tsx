import React from 'react'
import ReactDOM from 'react-dom'
import * as SSR from 'common/ssr'

export default () => {
  const getTextContent = (element: HTMLElement | null) => (element ? element.textContent : null)
  const ssrContext = JSON.parse(getTextContent(document.getElementById('ssr-context-hydrate')) || '[]')

  for (const { componentId, props } of ssrContext) {
    if (SSR.hasComponent(componentId)) {
      ReactDOM.hydrate(SSR.createElement(componentId, props), document.getElementById(props.id))
    }
  }
}
