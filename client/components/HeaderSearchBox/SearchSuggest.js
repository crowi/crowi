import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import queryString from 'query-string'
import Icon from 'components/Common/Icon'
import GroupedPageList from 'components/GroupedPageList/GroupedPageList'
import GroupedPageListTitle from 'components/GroupedPageList/GroupedPageListTitle'

class SearchSuggest extends React.Component {
  constructor(props) {
    super(props)

    this.buildSearchUrl = this.buildSearchUrl.bind(this)
    this.renderTitle = this.renderTitle.bind(this)
  }

  buildSearchUrl(type) {
    const q = this.props.searchingKeyword
    const query = queryString.stringify({ q, type })
    return `/_search?${query}`
  }

  renderTitle(type, title, icon) {
    const { t } = this.props
    return (
      <GroupedPageListTitle icon={icon} title={title}>
        <a className="more text-muted" href={this.buildSearchUrl(type)}>
          {t('search.suggest.more')}
          <Icon name="caret-right" />
        </a>
      </GroupedPageListTitle>
    )
  }

  render() {
    if (!this.props.focused) {
      return <div />
    }

    if (this.props.searching) {
      return (
        <div className="search-suggest" id="search-suggest">
          <i className="searcing fa fa-circle-o-notch fa-spin fa-fw" /> Searching ...
        </div>
      )
    }

    if (this.props.searchError !== null) {
      return (
        <div className="search-suggest" id="search-suggest">
          <i className="searcing fa fa-exclamation-triangle" /> Error on searching.
        </div>
      )
    }

    const numberOfResults = Object.values(this.props.searchedPages)
      .map((r = []) => r.length)
      .reduce((p, c) => p + c, 0)
    if (numberOfResults < 1) {
      if (this.props.searchingKeyword !== '') {
        return (
          <div className="search-suggest" id="search-suggest">
            No results for &quot;{this.props.searchingKeyword}&quot;.
          </div>
        )
      }
      return <div />
    }

    return (
      <div className="search-suggest" id="search-suggest">
        <GroupedPageList pages={this.props.searchedPages} title={this.renderTitle} />
      </div>
    )
  }
}

SearchSuggest.propTypes = {
  searchedPages: PropTypes.object.isRequired,
  searchingKeyword: PropTypes.string.isRequired,
  searching: PropTypes.bool.isRequired,
  searchError: PropTypes.object,
  focused: PropTypes.bool,
  t: PropTypes.func.isRequired,
}

SearchSuggest.defaultProps = {
  searchedPages: {},
  searchingKeyword: '',
  searchError: null,
  searching: false,
  focused: false,
}

export default translate()(SearchSuggest)
