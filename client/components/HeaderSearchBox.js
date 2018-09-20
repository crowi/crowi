// @flow
// This is the root component for #search-top

import React from 'react'
import queryString from 'query-string'

import SearchForm from './HeaderSearchBox/SearchForm'
import SearchSuggest from './HeaderSearchBox/SearchSuggest'

type Props = {
  crowi: Object,
}

export default class HeaderSearchBox extends React.Component {
  constructor(props: Props) {
    super(props)

    const { pathname = '', search: locationSearch } = this.props.crowi.location
    const parsedKeyword = queryString.parse(locationSearch).q || ''
    this.state = {
      isSearchPage: pathname.startsWith('/_search'),
      searchingKeyword: parsedKeyword,
      searchedPages: {},
      searchError: null,
      searching: false,
      focused: false,
    }

    this.search = this.search.bind(this)
    this.isShown = this.isShown.bind(this)
  }

  props: Props

  isShown(focused) {
    this.setState({ focused: !!focused })
  }

  async search(data) {
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
    const { isSearchPage } = this.state
    return (
      <div className="search-box">
        <SearchForm onSearchFormChanged={this.search} isShown={this.isShown} isSearchPage={isSearchPage} keyword={this.state.searchingKeyword} />
        {!isSearchPage && (
          <SearchSuggest
            searchingKeyword={this.state.searchingKeyword}
            searchedPages={this.state.searchedPages}
            searchError={this.state.searchError}
            searching={this.state.searching}
            focused={this.state.focused}
          />
        )}
      </div>
    )
  }
}
