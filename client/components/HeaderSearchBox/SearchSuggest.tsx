import React from 'react'
import { Card } from 'reactstrap'
import { withTranslation, WithTranslation } from 'react-i18next'
import queryString from 'query-string'
import Icon, { IconName } from 'components/Common/Icon'
import ListView from 'components/PageList/ListView'
import RecentlyViewedPageList from './RecentlyViewedPageList'
import { Page } from 'client/types/crowi'
import Crowi from 'client/util/Crowi'

interface Props extends WithTranslation {
  searchedPages: {
    portalPages?: []
    publicPages?: []
    userPages?: []
  }
  searchingKeyword: string
  searching: boolean
  searchError: Error | null
  focused: boolean
  crowi: Crowi
}

class SearchSuggest extends React.Component<Props> {
  static defaultProps = {
    searchedPages: {},
    searchingKeyword: '',
    searchError: null,
    searching: false,
    focused: false,
  }

  constructor(props: Props) {
    super(props)

    this.buildSearchUrl = this.buildSearchUrl.bind(this)
    this.renderList = this.renderList.bind(this)
  }

  buildSearchUrl(type: string) {
    const q = this.props.searchingKeyword
    const query = queryString.stringify({ q, type })
    return `/_search?${query}`
  }

  getNumberOfResults() {
    const { searchedPages } = this.props
    const groupedPages = Object.values(searchedPages)
    const sum = (array: any[]): number => array.reduce((p, c) => p + c, 0)
    return sum(groupedPages.map((r = []) => r.length))
  }

  renderList(title: string, icon: IconName, type: string, pages?: Page[]) {
    const { t } = this.props
    return (
      pages &&
      pages.length > 0 && (
        <div className="grouped-page-list" key={type}>
          <h6>
            <Icon name={icon} /> <span className="title">{title}</span>
            <a className="more text-muted" href={this.buildSearchUrl(type)}>
              {t('search.suggest.more')}
              <Icon name="chevronRight" />
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
    if (searchingKeyword === '') {
      return <RecentlyViewedPageList crowi={this.props.crowi} />
    }

    if (searching) {
      return (
        <div>
          <Icon name="loading" spin /> Searching ...
        </div>
      )
    }

    if (searchError !== null) {
      return (
        <div>
          <Icon name="alert" /> Error on searching.
        </div>
      )
    }

    if (numberOfResults === 0) {
      return <div>No results for &quot;{searchingKeyword}&quot;.</div>
    }

    return [
      this.renderList(t('page_types.portal'), 'fileDocumentBoxMultipleOutline', 'portal', portalPages),
      this.renderList(t('page_types.public'), 'fileDocumentBoxOutline', 'public', publicPages),
      this.renderList(t('page_types.user'), 'account', 'user', userPages),
    ]
  }

  render() {
    const { focused } = this.props

    if (!focused) {
      return <div />
    }

    return (
      <Card body className="search-suggest" id="search-suggest">
        {this.renderBody()}
      </Card>
    )
  }
}

export default withTranslation()(SearchSuggest)
