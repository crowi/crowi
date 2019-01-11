// This is the root component for #search-page

import React from 'react'
import PropTypes from 'prop-types'

import queryString from 'query-string'
import Emitter from '../emitter'
import SearchToolbar from 'components/SearchPage/SearchToolbar'
import SearchResult from './SearchPage/SearchResult/SearchResult'
import SearchToolbarSentinel from './SearchPage/SearchToolbarSentinel'

export default class SearchPage extends React.Component {
  constructor(props) {
    super(props)

    const { q = '', type = '' } = queryString.parse(this.props.crowi.location.search)
    this.state = {
      searching: false,
      searchingKeyword: q,
      searchingType: type,
      searchedPages: {},
      searchedMeta: {
        portal: { hasNext: null },
        public: { hasNext: null },
        user: { hasNext: null },
      },
      searchError: null,
      searched: false,
      total: 0,
      stuck: false,
    }

    this.search = this.search.bind(this)
    this.searchMore = this.searchMore.bind(this)
    this.buildQuery = this.buildQuery.bind(this)
    this.changeURL = this.changeURL.bind(this)
    this.changeType = this.changeType.bind(this)
    this.onStickyChange = this.onStickyChange.bind(this)

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
    const { searchingKeyword: q = '', searchingType: type = '' } = this.state
    const removeEmpty = query => Object.keys(query).forEach(k => !query[k] && delete query[k])
    const query = { q, type, ...override }
    removeEmpty(query)
    return query
  }

  changeURL({ q, type }, refreshHash) {
    let { hash = '' } = this.props.crowi.location
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
    this.search(this.buildQuery({ type }))
  }

  async search(query) {
    const { q = '', type = '' } = query
    if (q === '') {
      this.setState({
        searchingKeyword: '',
        searchedPages: {},
        searchedMeta: {
          portal: { hasNext: null },
          public: { hasNext: null },
          user: { hasNext: null },
        },
        searchError: null,
        searched: false,
        total: 0,
      })

      return true
    }

    this.setState({ searching: true })
    try {
      const [portalResult, publicResult, userResult] = await Promise.all(
        ['portal', 'public', 'user'].map(type => this.props.crowi.apiGet('/search', { ...query, type })),
      )
      const total = [portalResult, publicResult, userResult].map(result => result.meta.total).reduce((p, c) => p + c)
      const hasNext = ({ data, meta }) => data.length < meta.total

      this.changeURL(query)
      this.setState({
        searchingKeyword: q,
        searchingType: type,
        searchedPages: {
          portal: portalResult.data,
          public: publicResult.data,
          user: userResult.data,
        },
        searchedMeta: {
          portal: { hasNext: hasNext(portalResult), ...portalResult.meta },
          public: { hasNext: hasNext(publicResult), ...publicResult.meta },
          user: { hasNext: hasNext(userResult), ...userResult.meta },
        },
        searching: false,
        searched: true,
        total,
      })
    } catch (err) {
      // TODO error
      this.setState({ searchError: err, searching: false })
    }
  }

  async searchMore(type) {
    const { searchingKeyword: q, searchedPages, searchedMeta } = this.state

    const offset = searchedPages[type].length
    const result = await this.props.crowi.apiGet('/search', { q, type, offset })

    const pages = [...searchedPages[type], ...result.data]
    const hasNext = pages.length < result.meta.total
    const meta = { hasNext, ...result.meta }

    this.setState({
      searchedPages: {
        ...searchedPages,
        [type]: pages,
      },
      searchedMeta: {
        ...searchedMeta,
        [type]: meta,
      },
    })
  }

  onStickyChange(stuck) {
    this.setState({ stuck })
  }

  render() {
    const { toolbar, onStickyChange } = this
    return (
      <div className="content-main">
        <SearchToolbarSentinel target={toolbar} onStickyChange={onStickyChange} />
        <SearchToolbar
          keyword={this.state.searchingKeyword}
          type={this.state.searchingType}
          total={this.state.total}
          searching={this.state.searching}
          stuck={this.state.stuck}
          changeType={this.changeType}
        />
        <SearchResult
          pages={this.state.searchedPages}
          meta={this.state.searchedMeta}
          searchingKeyword={this.state.searchingKeyword}
          searched={this.state.searched}
          searchMore={this.searchMore}
        />
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
