import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import { Tab } from 'components/Common/Tab'
import { TabItem } from 'components/Common/TabItem'
import { ShareList } from 'components/Admin/Share/ShareList'
import { AccessLog } from 'components/Admin/Share/AccessLog'
import Crowi from 'client/util/Crowi'

interface Props extends WithTranslation {
  crowi: Crowi
}

class AdminShareComponent extends React.Component<Props> {
  constructor(props: Props) {
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

export const AdminShare = withTranslation()(AdminShareComponent)
