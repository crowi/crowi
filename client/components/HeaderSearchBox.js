// This is the root component for #search-top

import React from 'react'
import PropTypes from 'prop-types'
import queryString from 'query-string'

import SearchForm from './HeaderSearchBox/SearchForm'
import SearchSuggest from './HeaderSearchBox/SearchSuggest'

export default class HeaderSearchBox extends React.Component {
  constructor(props) {
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
    this.handleClick = this.handleClick.bind(this)
    this.handleClickOutside = this.handleClickOutside.bind(this)
  }

  componentDidMount() {
    document.addEventListener('mousedown', this.handleClick, false)
  }

  componentWillUnmount() {
    document.removeEventListener('mousedown', this.handleClick, false)
  }

  isShown(focused) {
    this.setState({ focused: !!focused })
  }

  handleClick(e) {
    if (!this.node.contains(e.target)) {
      this.handleClickOutside()
    }
  }

  handleClickOutside() {
    this.isShown(false)
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
      <div className="search-box" ref={node => (this.node = node)}>
        <SearchForm onSearchFormChanged={this.search} isShown={this.isShown} isSearchPage={isSearchPage} keyword={this.state.searchingKeyword} />
        {!isSearchPage && (
          <SearchSuggest
            searchingKeyword={this.state.searchingKeyword}
            searchedPages={this.state.searchedPages}
            searchError={this.state.searchError}
            searching={this.state.searching}
            focused={this.state.focused}
            crowi={this.props.crowi}
          />
        )}
      </div>
    )
  }
}

HeaderSearchBox.propTypes = {
  crowi: PropTypes.object.isRequired,
  // pollInterval: PropTypes.number,
}
HeaderSearchBox.defaultProps = {
  // pollInterval: 1000,
}
