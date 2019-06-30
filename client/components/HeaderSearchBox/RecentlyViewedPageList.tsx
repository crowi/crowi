import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import Icon from 'components/Common/Icon'
import ListView from 'components/PageList/ListView'
import Crowi from 'client/util/Crowi'

interface Props extends WithTranslation {
  crowi: Crowi
}

interface State {
  pages: []
}

class RecentlyViewedPageList extends React.Component<Props, State> {
  constructor(props) {
    super(props)

    this.state = {
      pages: [],
    }
  }

  async componentDidMount() {
    const { pages } = await this.props.crowi.apiGet('/user/recentlyViewed', {})
    this.setState({ pages })
  }

  render() {
    const { t } = this.props
    const { pages } = this.state
    return (
      pages.length > 0 && (
        <div className="grouped-page-list">
          <h6>
            <Icon name="history" />
            <span className="title">{t('Recently Viewed Pages')}</span>
          </h6>
          <ListView pages={pages} />
        </div>
      )
    )
  }
}

export default withTranslation()(RecentlyViewedPageList)
