import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import Icon from 'components/Common/Icon'
import ListView from 'components/PageList/ListView'

class RecentlyViewedPageList extends React.Component {
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
          <h5>
            <Icon name="history" />
            <span className="title">{t('Recently Viewed Pages')}</span>
          </h5>
          <ListView pages={pages} />
        </div>
      )
    )
  }
}

RecentlyViewedPageList.propTypes = {
  crowi: PropTypes.object.isRequired,
  t: PropTypes.func.isRequired,
}

export default translate()(RecentlyViewedPageList)
