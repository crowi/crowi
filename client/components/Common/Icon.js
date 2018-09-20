// @flow
import React from 'react'

type Props = {
  name: string,
  solid?: boolean,
  regular?: boolean,
  light?: boolean,
  spin?: boolean,
}

export default class Icon extends React.Component<Props> {
  static defaltProps = {
    spin: false,
    solid: false,
    regular: false,
    light: false,
  }

  render() {
    const name = this.props.name || null
    const isSpin = this.props.spin ? 'fa-spinner fa-pulse' : ''
    const { solid: s, regular: r, light: l } = this.props
    const type = s ? 's' : r ? 'r' : l ? 'l' : ''

    if (!name) {
      return ''
    }

    return <i className={`fa${type} fa-${name} ${isSpin}`} />
  }
}
