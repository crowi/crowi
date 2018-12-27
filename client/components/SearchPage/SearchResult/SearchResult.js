import React from 'react'
import PropTypes from 'prop-types'

import PagePathList from './PagePathList'
import PageBodyList from './PageBodyList'

// Search.SearchResult
export default class SearchResult extends React.Component {
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

    const isSearchPage = !!document.getElementById('search-page')
    const offset = isSearchPage ? { top: 54 } : { top: 104 }

    // TODO あとでなんとかする
    setTimeout(() => {
      $('#search-result-list > nav').affix({ offset })
    }, 1200)

    const { pages, tree: excludePathString, searchingKeyword } = this.props

    return (
      <div className="search-result row" id="search-result">
        <div className="col-md-4 hidden-xs hidden-sm page-list search-result-list" id="search-result-list">
          <nav data-spy="affix" data-offset-top={offset.top}>
            <PagePathList pages={pages} excludePathString={excludePathString} />
          </nav>
        </div>
        <div className="col-md-8 search-result-content" id="search-result-content">
          <PageBodyList pages={pages} searchingKeyword={searchingKeyword} />
        </div>
      </div>
    )
  }
}

SearchResult.propTypes = {
  tree: PropTypes.string.isRequired,
  pages: PropTypes.array.isRequired,
  searchingKeyword: PropTypes.string.isRequired,
  searchResultMeta: PropTypes.object.isRequired,
  searchError: PropTypes.object,
}
SearchResult.defaultProps = {
  tree: '',
  pages: [],
  searchingKeyword: '',
  searchResultMeta: {},
  searchError: null,
}
