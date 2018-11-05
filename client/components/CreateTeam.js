import React from 'react'
import PropTypes from 'prop-types'

import { Modal } from 'react-bootstrap'

export default class CreateTeam extends React.Component {
  render() {
    return (
      <Modal>
        <div>Hoge</div>
      </Modal>
    )
  }
}

CreateTeam.PropTypes = {
  crowi: PropTypes.object.isRequired,
}
