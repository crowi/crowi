// This is the root component for #search-top

import React from 'react'
import queryString from 'query-string'

import SearchForm from './HeaderSearchBox/SearchForm'
import SearchSuggest from './HeaderSearchBox/SearchSuggest'
import Crowi from 'client/util/Crowi'

interface Props {
  crowi: Crowi
}

interface State {
  isSearchPage: boolean
  searchingKeyword: string
  searchedPages: {}
  searchError: Error | null
  searching: boolean
  focused: boolean
}

export default class HeaderSearchBox extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    const { pathname = '', search: locationSearch } = this.props.crowi.location
    const parsedKeyword = queryString.parse(locationSearch).q || ''
    this.state = {
      isSearchPage: pathname.startsWith('/_search'),
      searchingKeyword: String(parsedKeyword),
      searchedPages: {},
      searchError: null,
      searching: false,
      focused: false,
    }

    this.search = this.search.bind(this)
    this.isShown = this.isShown.bind(this)
  }

  isShown(focused: boolean) {
    this.setState({ focused })
  }

  async search(data: { keyword: string }) {
    const keyword = data.keyword
    if (keyword === '') {
      this.setState({
        searchingKeyword: '',
        searchedPages: [],
      })

      return true
    }

    this.setState({
      searchingKeyword: keyword,
      searching: true,
    })

    try {
      const [{ data: portalPages }, { data: publicPages }, { data: userPages }] = await Promise.all(
        ['portal', 'public', 'user'].map(type => this.props.crowi.apiGet('/search', { q: keyword, type, limit: 10 })),
      )
      this.setState({
        searchingKeyword: keyword,
        searchedPages: { portalPages, publicPages, userPages },
        searching: false,
        searchError: null,
      })
    } catch (err) {
      this.setState({
        searchError: err,
        searching: false,
      })
    }
  }

  render() {
    const { isSearchPage, searchingKeyword, searchedPages, searchError, searching, focused } = this.state
    return (
      <div className="search-box">
        <SearchForm onSearchFormChanged={this.search} isShown={this.isShown} isSearchPage={isSearchPage} keyword={this.state.searchingKeyword} />
        {!isSearchPage && (
          <SearchSuggest searchingKeyword={searchingKeyword} searchedPages={searchedPages} searchError={searchError} searching={searching} focused={focused} />
        )}
      </div>
    )
  }
}
