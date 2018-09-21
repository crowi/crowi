// @flow
import React from 'react'

import Page from 'components/PageList/Page'
import SearchResultList from './SearchResultList'

type Props = {
  tree: string,
  pages: Array<any>,
  searchingKeyword: string,
  searchResultMeta: Object,
  searchError: ?Error,
}

type State = {
  active: ?string,
}

// Search.SearchResult
export default class SearchResult extends React.Component<Props, State> {
  static defaultProps = {
    tree: '',
    pages: [],
    searchingKeyword: '',
    searchResultMeta: {},
    searchError: null,
  }

  constructor(props: Props) {
    super(props)

    this.state = { active: null }
  }

  updateActivePage(pageId: string) {
    if (this.state.active !== pageId) {
      this.setState({ active: pageId })
    }
  }

  isNotSearchedYet() {
    return this.props.searchResultMeta.took === undefined
  }

  isNotFound() {
    return this.props.searchingKeyword !== '' && this.props.pages.length === 0
  }

  isError() {
    if (this.props.searchError !== null) {
      return true
    }
    return false
  }

  render() {
    const excludePathString = this.props.tree

    // console.log(this.props.searchError);
    // console.log(this.isError());
    if (this.isError()) {
      return (
        <div>
          <i className="searcing fa fa-exclamation-triangle" /> Error on searching.
        </div>
      )
    }

    if (this.isNotSearchedYet()) {
      return <div />
    }

    if (this.isNotFound()) {
      let under = ''
      if (this.props.tree !== '') {
        under = ` under "${this.props.tree}"`
      }
      return (
        <div>
          <i className="fa fa-meh" /> No page found with &quot;{this.props.searchingKeyword}&quot;{under}
        </div>
      )
    }

    const listView = this.props.pages.map(page => {
      const pageId = '#' + page._id
      return (
        <Page
          page={page}
          linkTo={pageId}
          key={page._id}
          excludePathString={excludePathString}
          isActive={this.state.active === page._id}
          onClick={() => this.updateActivePage(page._id)}
        >
          <div className="page-list-option">
            <a href={page.path}>
              <i className="fa fa-arrow-circle-right" />
            </a>
          </div>
        </Page>
      )
    })

    return (
      <div className="search-result row" id="search-result">
        <div className="col-md-4 d-none d-md-block page-list search-result-list" id="search-result-list">
          <nav>
            <ul className="page-list-ul nav">{listView}</ul>
          </nav>
        </div>
        <div className="col-md-8 search-result-content" id="search-result-content">
          <SearchResultList pages={this.props.pages} searchingKeyword={this.props.searchingKeyword} />
        </div>
      </div>
    )
  }
}
