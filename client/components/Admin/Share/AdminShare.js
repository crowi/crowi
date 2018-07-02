import React from 'react'
import PropTypes from 'prop-types'
import { Tabs, Tab } from 'react-bootstrap'
import ShareList from './ShareList'
import AccessLog from './AccessLog'

export default class AdminShare extends React.Component {
  constructor(props) {
    super(props)

    this.state = {}
  }

  render() {
    return (
      <Tabs defaultActiveKey={1} animation={false}>
        <Tab eventKey={1} title="共有しているページ">
          <ShareList crowi={this.props.crowi} />
        </Tab>
        <Tab eventKey={2} title="アクセスログ">
          <AccessLog crowi={this.props.crowi} />
        </Tab>
      </Tabs>
    )
  }
}

AdminShare.propTypes = {
  crowi: PropTypes.object.isRequired,
}
