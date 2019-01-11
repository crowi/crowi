import React from 'react'
import PropTypes from 'prop-types'
import PagePathList from './PagePathList'
import PageBodyList from './PageBodyList'
import GroupedPageList from 'components/GroupedPageList/GroupedPageList'

// Search.SearchResult
export default class SearchResult extends React.Component {
  constructor(props) {
    super(props)

    this.renderList = this.renderList.bind(this)
  }

  isNotSearchedYet() {
    return !this.props.searched
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

  renderList(type, pages) {
    const { tree: excludePathString } = this.props
    return <PagePathList pages={pages} excludePathString={excludePathString} />
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

    const { pages, searchingKeyword } = this.props

    return (
      <div className="search-result row" id="search-result">
        <div className="col-md-4 hidden-xs hidden-sm page-list search-result-list" id="search-result-list">
          <nav data-spy="affix" data-offset-top={offset.top}>
            <GroupedPageList pages={pages} list={this.renderList} />
          </nav>
        </div>
        <div className="col-md-8 search-result-content" id="search-result-content">
          <PageBodyList pages={pages.portal} searchingKeyword={searchingKeyword} />
          <PageBodyList pages={pages.public} searchingKeyword={searchingKeyword} />
          <PageBodyList pages={pages.user} searchingKeyword={searchingKeyword} />
        </div>
      </div>
    )
  }
}

SearchResult.propTypes = {
  tree: PropTypes.string.isRequired,
  pages: PropTypes.object.isRequired,
  searchingKeyword: PropTypes.string.isRequired,
  searchError: PropTypes.object,
  searched: PropTypes.bool.isRequired,
}
SearchResult.defaultProps = {
  tree: '',
  pages: [],
  searchingKeyword: '',
  searchResultMeta: {},
  searchError: null,
}
