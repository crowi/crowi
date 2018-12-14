import React from 'react'

// TODO: support size and so far
interface Props {
  name: string
  solid?: boolean
  regular?: boolean
  light?: boolean
  spin?: boolean
  className?: string
}

export default class Icon extends React.Component<Props> {
  static defaultProps = { spin: false, solid: false, regular: false, light: false }

  render() {
    const { name, spin, solid, regular, light, className: c, ...props } = this.props
    const { solid: s, regular: r, light: l } = { solid, regular, light }

    const isSpin = spin ? 'fa-spinner fa-pulse' : ''
    const type = s ? 's' : r ? 'r' : l ? 'l' : ''

    const className = [`fa${type}`, `fa-${name}`, isSpin, c].filter(Boolean).join(' ')

    if (!name) {
      return ''
    }

    return <i className={className} {...props} />
  }
}
