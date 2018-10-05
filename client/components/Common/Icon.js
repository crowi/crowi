import React from 'react'
import PropTypes from 'prop-types'

export default class Icon extends React.Component {
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

// TODO: support size and so far
Icon.propTypes = {
  name: PropTypes.string.isRequired,
  solid: PropTypes.bool,
  regular: PropTypes.bool,
  light: PropTypes.bool,
  spin: PropTypes.bool,
  className: PropTypes.string,
}

Icon.defaltProps = {
  spin: false,
  solid: false,
  regular: false,
  light: false,
}
