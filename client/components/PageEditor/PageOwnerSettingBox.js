import React from 'react'
import PropTypes from 'prop-types'

import CreateTeam from 'components/CreateTeam'

export default class PageOwnerBox extends React.Component {
  render() {
    return <div style={{ height: '600px', width: '600px' }}>{this.props.pageId}</div>
  }
}

CreateTeam.PropTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
}
