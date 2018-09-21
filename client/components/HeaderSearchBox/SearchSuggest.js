// @flow
import React from 'react'
import type { Node } from 'react'
import { Card } from 'reactstrap'
import { translate } from 'react-i18next'
import queryString from 'query-string'
import Icon from 'components/Common/Icon'
import ListView from 'components/PageList/ListView'

type Props = {
  searchedPages: Object,
  searchingKeyword: string,
  searching: boolean,
  searchError?: ?Error,
  focused?: boolean,
  t: Function,
}

class SearchSuggest extends React.Component<Props> {
  static defaultProps = {
    searchedPages: {},
    searchingKeyword: '',
    searchError: null,
    searching: false,
    focused: false,
  }

  buildSearchUrl = type => {
    const q = this.props.searchingKeyword
    const query = queryString.stringify({ q, type })
    return `/_search?${query}`
  }

  getNumberOfResults() {
    const { searchedPages } = this.props
    const groupedPages: Array<any> = Object.values(searchedPages)
    const sum = array => array.reduce((p, c) => p + c, 0)
    return sum(groupedPages.map((r = []) => r.length))
  }

  renderList = (title, icon, type, pages) => {
    const { t } = this.props
    return (
      pages.length > 0 && (
        <div className="grouped-page-list" key={type}>
          <h6>
            <Icon name={icon} regular />
            <span className="title">{title}</span>
            <a className="more text-muted" href={this.buildSearchUrl(type)}>
              {t('search.suggest.more')}
              <Icon name="caret-right" />
            </a>
          </h6>
          <ListView pages={pages} />
        </div>
      )
    )
  }

  renderBody() {
    const { t, searching, searchError, searchedPages, searchingKeyword } = this.props
    const numberOfResults = this.getNumberOfResults()
    const { portalPages, publicPages, userPages } = searchedPages
    if (searching) {
      return (
        <div>
          <i className="searching fa fa-circle-o-notch fa-spin fa-fw" /> Searching ...
        </div>
      )
    }
    if (searchError !== null) {
      return (
        <div>
          <i className="searcing fa fa-exclamation-triangle" /> Error on searching.
        </div>
      )
    }
    if (numberOfResults === 0) {
      return <div>No results for &quot;{searchingKeyword}&quot;.</div>
    }
    return [
      this.renderList(t('page_types.portal'), 'circle', 'portal', portalPages),
      this.renderList(t('page_types.public'), 'file', 'public', publicPages),
      this.renderList(t('page_types.user'), 'user', 'user', userPages),
    ]
  }

  render() {
    const { focused, searchingKeyword } = this.props
    const numberOfResults = this.getNumberOfResults()
    const searched = numberOfResults >= 1 || searchingKeyword !== ''
    if (!focused || !searched) {
      return <div />
    }

    return (
      <Card body className="search-suggest" id="search-suggest">
        {this.renderBody()}
      </Card>
    )
  }
}

export default translate()(SearchSuggest)
