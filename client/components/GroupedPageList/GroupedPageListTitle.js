import React from 'react'
import PropTypes from 'prop-types'

import Icon from 'components/Common/Icon'

export default class GroupedPageListTitle extends React.Component {
  render() {
    const { icon, title, children } = this.props
    return (
      <h5>
        <Icon name={icon} regular />
        <span className="title">{title}</span>
        {children}
      </h5>
    )
  }
}

GroupedPageListTitle.propTypes = {
  icon: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  children: PropTypes.element,
}
