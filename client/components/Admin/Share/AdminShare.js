import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Tabs, Tab } from 'react-bootstrap'
import ShareList from './ShareList'
import AccessLog from './AccessLog'

class AdminShare extends React.Component {
  constructor(props) {
    super(props)

    this.state = {}
  }

  render() {
    const { t } = this.props
    return (
      <Tabs defaultActiveKey={1} animation={false}>
        <Tab eventKey={1} title={t('Shared Pages')}>
          <ShareList crowi={this.props.crowi} />
        </Tab>
        <Tab eventKey={2} title={t('Access Log')}>
          <AccessLog crowi={this.props.crowi} />
        </Tab>
      </Tabs>
    )
  }
}

AdminShare.propTypes = {
  t: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired,
}

export default translate()(AdminShare)
