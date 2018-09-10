// This is the root component for #search-page

import React from 'react'
import PropTypes from 'prop-types'

import queryString from 'query-string'
import Emitter from '../emitter'
import SearchToolbar from 'components/SearchPage/SearchToolbar'
import SearchResult from './SearchPage/SearchResult'

export default class SearchPage extends React.Component {
  constructor(props) {
    super(props)

    const { q = '', type = '', language } = queryString.parse(this.props.crowi.location.search)
    this.state = {
      searching: false,
      searchingKeyword: q,
      searchingType: type,
      searchingLanguage: language,
      searchedPages: [],
      searchResultMeta: {},
      searchError: null,
    }

    this.search = this.search.bind(this)
    this.buildQuery = this.buildQuery.bind(this)
    this.searchWithQuery = this.searchWithQuery.bind(this)
    this.changeURL = this.changeURL.bind(this)

    Emitter.on('search', ({ keyword: q = '' }) => {
      this.search(this.buildQuery({ q }))
    })
  }

  componentDidMount() {
    if (this.state.searchingKeyword !== '') {
      this.search(this.buildQuery())
    }
  }

  buildQuery(override) {
    const { searchingKeyword: q = '', searchingType: type = '', searchingLanguage: language } = this.state
    const removeEmpty = query => Object.keys(query).forEach(k => !query[k] && delete query[k])
    const query = { q, type, language, ...override }
    removeEmpty(query)
    return query
  }

  changeURL({ q, type, language }, refreshHash) {
    let { hash = '' } = this.props.crowi.location
    // TODO 整理する
    if (refreshHash || q !== '') {
      hash = ''
    }
    const query = queryString.stringify({ q, type, language })
    if (window.history && window.history.pushState) {
      window.history.pushState('', `Search - ${q}`, `/_search?${query}${hash}`)
    }
  }

  searchWithQuery(query) {
    this.search(this.buildQuery(query))
  }

  async search(query) {
    const { q = '', type = '', language } = query
    if (q === '') {
      this.setState({
        searchingKeyword: '',
        searchedPages: [],
        searchResultMeta: {},
        searchError: null,
      })

      return true
    }

    this.setState({ searching: true })
    try {
      const { data, meta } = await this.props.crowi.apiGet('/search', query)
      this.changeURL(query)
      this.setState({
        searchingKeyword: q,
        searchingType: type,
        searchingLanguage: language,
        searchedPages: data,
        searchResultMeta: meta,
        searching: false,
      })
    } catch (err) {
      // TODO error
      this.setState({ searchError: err, searching: false })
    }
  }

  render() {
    return (
      <div className="content-main">
        <SearchToolbar
          crowi={crowi}
          keyword={this.state.searchingKeyword}
          type={this.state.searchingType}
          language={this.state.searchingLanguage}
          total={this.state.searchResultMeta.total}
          searching={this.state.searching}
          search={this.searchWithQuery}
        />
        <SearchResult pages={this.state.searchedPages} searchingKeyword={this.state.searchingKeyword} searchResultMeta={this.state.searchResultMeta} />
      </div>
    )
  }
}

SearchPage.propTypes = {
  crowi: PropTypes.object.isRequired,
}
SearchPage.defaultProps = {
  // pollInterval: 1000,
  searchError: null,
}
