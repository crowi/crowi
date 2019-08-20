import React from 'react'
import Icon from 'components/Common/Icon'

export const components = {
  Icon,
}

export const hasComponent = (componentId: string) => {
  return componentId in components
}

export const getComponent = (componentId: string) => {
  return components[componentId]
}

export const createElement = (componentId: string, props) => {
  if (hasComponent(componentId)) {
    return React.createElement(getComponent(componentId), props)
  }

  return React.createElement('')
}
