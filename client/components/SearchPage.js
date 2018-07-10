// This is the root component for #search-page

import React from 'react'
import PropTypes from 'prop-types'

import queryString from 'query-string'
// import SearchForm from './SearchPage/SearchForm'
import SearchToolbar from 'components/SearchPage/SearchToolbar'
import SearchResult from './SearchPage/SearchResult'

export default class SearchPage extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      location: location,
      searchingKeyword: this.props.query.q || '',
      searchingType: this.props.query.type || '',
      searchedPages: [],
      searchResultMeta: {},
      searchError: null,
    }

    this.search = this.search.bind(this)
    this.buildQuery = this.buildQuery.bind(this)
    this.changeURL = this.changeURL.bind(this)
    this.changeType = this.changeType.bind(this)
  }

  componentDidMount() {
    if (this.state.searchingKeyword !== '') {
      this.search(this.buildQuery())
    }
  }

  buildQuery(override) {
    const { searchingKeyword: q = '', searchingType: type = '' } = this.state
    const removeEmpty = query => Object.keys(query).forEach(k => !query[k] && delete query[k])
    const query = { q, type, ...override }
    removeEmpty(query)
    return query
  }

  changeURL({ q, type }, refreshHash) {
    let hash = location.hash || ''
    // TODO 整理する
    if (refreshHash || q !== '') {
      hash = ''
    }
    const query = queryString.stringify({ q, type })
    if (window.history && window.history.pushState) {
      window.history.pushState('', `Search - ${q}`, `/_search?${query}${hash}`)
    }
  }

  changeType(type) {
    const query = this.buildQuery({ type })
    this.search(query)
  }

  search(query) {
    const { q = '', type = '' } = query
    if (q === '') {
      this.setState({
        searchingKeyword: '',
        searchedPages: [],
        searchResultMeta: {},
        searchError: null,
      })

      return true
    }

    this.props.crowi
      .apiGet('/search', query)
      .then(res => {
        this.changeURL(query)
        this.setState({
          searchingKeyword: q,
          searchingType: type,
          searchedPages: res.data,
          searchResultMeta: res.meta,
        })
      })
      .catch(err => {
        // TODO error
        this.setState({
          searchError: err,
        })
      })
  }

  render() {
    return (
      <div className="content-main">
        <SearchToolbar
          keyword={this.state.searchingKeyword}
          type={this.state.searchingType}
          total={this.state.searchResultMeta.total}
          changeType={this.changeType}
        />
        {/* <div className="header-wrap">
          <header>
            <SearchForm onSearchFormChanged={this.search} keyword={this.state.searchingKeyword} />
          </header>
        </div> */}

        <SearchResult
          pages={this.state.searchedPages}
          searchingKeyword={this.state.searchingKeyword}
          searchResultMeta={this.state.searchResultMeta}
        />
      </div>
    )
  }
}

SearchPage.propTypes = {
  query: PropTypes.object,
  crowi: PropTypes.object.isRequired,
}
SearchPage.defaultProps = {
  // pollInterval: 1000,
  query: queryString.parse(location.search),
  searchError: null,
}
