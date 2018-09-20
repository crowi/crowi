// @flow
import React from 'react'
import { translate } from 'react-i18next'
import Tab from 'components/Common/Tab'
import TabItem from 'components/Common/TabItem'
import ShareList from './ShareList'
import AccessLog from './AccessLog'

type Props = {
  t: Function,
  crowi: Object,
}

class AdminShare extends React.Component {
  constructor(props: Props) {
    super(props)

    this.state = {}
  }

  props: Props

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

export default translate()(AdminShare)
