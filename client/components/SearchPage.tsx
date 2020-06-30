// This is the root component for #search-page

import React from 'react'

import queryString from 'query-string'
import Emitter from '../emitter'
import SearchToolbar from 'components/SearchPage/SearchToolbar'
import SearchResult from './SearchPage/SearchResult'
import Crowi from 'client/util/Crowi'
import { Page } from 'client/types/crowi'

interface Props {
  crowi: Crowi
}

interface State {
  searching: boolean
  searchingKeyword: string
  searchingType: string
  searchedPages: Page[]
  searchResultMeta: { total?: number }
  searchError: Error | null
}

interface Query {
  q: string
  type: string
}

export default class SearchPage extends React.Component<Props, State> {
  static defaultProps = { searchError: null }

  constructor(props: Props) {
    super(props)

    const { q = '', type = '' } = queryString.parse(this.props.crowi.location.search)
    this.state = {
      searching: false,
      searchingKeyword: String(q),
      searchingType: String(type),
      searchedPages: [],
      searchResultMeta: {},
      searchError: null,
    }

    this.search = this.search.bind(this)
    this.buildQuery = this.buildQuery.bind(this)
    this.changeURL = this.changeURL.bind(this)
    this.changeType = this.changeType.bind(this)

    Emitter.on('search', ({ keyword: q = '' }) => {
      this.search(this.buildQuery({ q }))
    })
  }

  componentDidMount() {
    if (this.state.searchingKeyword !== '') {
      this.search(this.buildQuery())
    }
  }

  buildQuery(override = {}) {
    const { searchingKeyword: q = '', searchingType: type = '' } = this.state
    const removeEmpty = (query: any) => Object.keys(query).forEach((k) => !query[k] && delete query[k])
    const query = { q, type, ...override }
    removeEmpty(query)
    return query
  }

  changeURL({ q, type }: Query, refreshHash = false) {
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

  changeType(type: string) {
    this.search(this.buildQuery({ type }))
  }

  async search(query: Query) {
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

    this.setState({ searching: true })
    try {
      const { data, meta } = await this.props.crowi.apiGet('/search', query)
      this.changeURL(query)
      this.setState({
        searchingKeyword: q,
        searchingType: type,
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
          keyword={this.state.searchingKeyword}
          type={this.state.searchingType}
          total={this.state.searchResultMeta.total}
          searching={this.state.searching}
          changeType={this.changeType}
        />
        <SearchResult pages={this.state.searchedPages} searchingKeyword={this.state.searchingKeyword} searchResultMeta={this.state.searchResultMeta} />
      </div>
    )
  }
}
