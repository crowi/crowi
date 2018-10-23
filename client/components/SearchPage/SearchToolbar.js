import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import Icon from 'components/Common/Icon'
import SearchTypeNav from 'components/SearchPage/SearchTypeNav/SearchTypeNav'

class SearchToolbar extends React.Component {
  constructor(props) {
    super(props)

    const { t } = this.props
    this.searchTypes = [
      {
        key: '',
        icon: <Icon name="th" />,
        name: t('page_types.all'),
      },
      {
        key: 'portal',
        icon: <Icon name="circle" regular />,
        name: t('page_types.portal'),
      },
      {
        key: 'public',
        icon: <Icon name="file" regular />,
        name: t('page_types.public'),
      },
      {
        key: 'user',
        icon: <Icon name="user" regular />,
        name: t('page_types.user'),
      },
    ]

    this.getActiveType = this.getActiveType.bind(this)
  }

  getActiveType() {
    const defaultType = this.searchTypes[0]
    const searchTypes = this.searchTypes.reduce((object, { key, icon, name }) => ({ ...object, [key]: { key, icon, name } }), {})
    const { type: searchType } = this.props
    return searchType in searchTypes ? searchTypes[searchType] : defaultType
  }

  render() {
    const { t, changeType } = this.props
    const activeType = this.getActiveType()
    return (
      <div className="search-toolbar row">
        <div className="search-meta col-md-4">
          <h3 className="search-keyword">{this.props.keyword}</h3>
          <small className="text-muted">
            {(this.props.searching && <Icon name="spinner" spin />) || t('search.toolbar.results', { value: this.props.total })}
          </small>
        </div>
        <nav className="search-navbar col-md-8">
          <SearchTypeNav searchTypes={this.searchTypes} activeType={activeType} changeType={changeType} />
        </nav>
      </div>
    )
  }
}

SearchToolbar.propTypes = {
  keyword: PropTypes.string,
  type: PropTypes.string,
  total: PropTypes.number,
  changeType: PropTypes.func,
  searching: PropTypes.boolean,
  t: PropTypes.func.isRequired,
}
SearchToolbar.defaultProps = {
  keyword: '',
  type: '',
  searching: false,
  total: 0,
}

export default translate()(SearchToolbar)
