import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import Tab from 'components/Common/Tab'
import TabItem from 'components/Common/TabItem'
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
      <Tab id="admin-share-tabs">
        <TabItem title={t('Shared Pages')}>
          <ShareList crowi={this.props.crowi} />
        </TabItem>
        <TabItem title={t('Access Log')}>
          <AccessLog crowi={this.props.crowi} />
        </TabItem>
      </Tab>
    )
  }
}

AdminShare.propTypes = {
  t: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired,
}

export default translate()(AdminShare)
