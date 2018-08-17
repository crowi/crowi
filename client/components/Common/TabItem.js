import React from 'react'
import PropTypes from 'prop-types'

export default class TabItem extends React.Component {
  render() {
    return this.props.children
  }
}

TabItem.propTypes = {
  title: PropTypes.string.isRequired,
}

TabItem.defaultProps = {
  title: '',
}
