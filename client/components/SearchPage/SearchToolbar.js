import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import Icon from 'components/Common/Icon'

class SearchToolbar extends React.Component {
  render() {
    const { t, stuck } = this.props
    const className = ['search-toolbar', stuck ? 'stuck' : null].filter(Boolean).join(' ')
    return (
      <div className={className}>
        <div className="search-meta col-md-4">
          <h3 className="search-keyword">{this.props.keyword}</h3>
          <small className="text-muted">
            {(this.props.searching && <Icon name="spinner" spin />) || t('search.toolbar.results', { value: this.props.total })}
          </small>
        </div>
      </div>
    )
  }
}

SearchToolbar.propTypes = {
  keyword: PropTypes.string,
  type: PropTypes.string,
  total: PropTypes.number,
  searching: PropTypes.bool,
  t: PropTypes.func.isRequired,
  stuck: PropTypes.bool.isRequired,
}
SearchToolbar.defaultProps = {
  keyword: '',
  type: '',
  searching: false,
  total: 0,
  stuck: false,
}

export default translate()(SearchToolbar)
