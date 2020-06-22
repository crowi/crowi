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
  loading: boolean
}

class RecentlyViewedPageList extends React.Component<Props, State> {
  constructor(props) {
    super(props)

    this.state = {
      pages: [],
      loading: true,
    }
  }

  async componentDidMount() {
    const { pages } = await this.props.crowi.apiGet('/user/recentlyViewed', {})
    this.setState({ pages, loading: false })
  }

  render() {
    const { t } = this.props
    const { pages, loading } = this.state
    return (
      <div className="grouped-page-list">
        <h6>
          <Icon name="history" /> <span className="title">{t('Recently Viewed Pages')}</span>
        </h6>
        {loading ? <Icon name="loading" spin /> : pages.length === 0 ? 'No recently viewed pages' : <ListView pages={pages} />}
      </div>
    )
  }
}

export default withTranslation()(RecentlyViewedPageList)
