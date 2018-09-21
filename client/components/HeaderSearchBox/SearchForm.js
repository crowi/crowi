// @flow
import React from 'react'

import Emitter from '../../emitter'

type Props = {
  onSearchFormChanged: Function,
  isShown: Function,
  isSearchPage: boolean,
  pollInterval?: number,
  keyword?: string,
}

type State = {
  keyword: ?string,
  searchedKeyword: ?string,
}

// Header.SearchForm
export default class SearchForm extends React.Component<Props, State> {
  static defaultProps = {
    pollInterval: 1000,
  }

  ticker: ?IntervalID

  constructor(props: Props) {
    super(props)

    this.state = {
      keyword: props.keyword,
      searchedKeyword: '',
    }

    this.ticker = null
  }

  componentDidMount() {
    this.ticker = setInterval(this.searchFieldTicker, this.props.pollInterval)
  }

  componentWillUnmount() {
    if (this.ticker) {
      clearInterval(this.ticker)
    }
  }

  search() {
    const { keyword, searchedKeyword } = this.state
    if (keyword !== searchedKeyword) {
      this.props.onSearchFormChanged({ keyword })
      this.setState({ searchedKeyword: keyword })
    }
  }

  getFormClearComponent() {
    if (this.state.keyword !== '') {
      return (
        <a className="search-top-clear" onClick={this.clearForm}>
          <i className="fa fa-times-circle" />
        </a>
      )
    } else {
      return ''
    }
  }

  clearForm = () => {
    this.setState({ keyword: '' })
    this.search()
  }

  searchFieldTicker = () => {
    this.search()
  }

  handleFocus = (event: Event) => {
    this.props.isShown(true)
  }

  handleBlur = (event: Event) => {
    // this.props.isShown(false)
  }

  handleChange = (event: SyntheticInputEvent<HTMLInputElement>) => {
    const keyword = event.target.value
    this.setState({ keyword })
  }

  handleSubmit = (e: Event) => {
    const { keyword } = this.state
    const { isSearchPage } = this.props
    if (isSearchPage) {
      e.preventDefault()
      Emitter.emit('search', { keyword })
    }
  }

  render() {
    const formClear = this.getFormClearComponent()

    return (
      <form action="/_search" className="search-form input-group search-top-input-group" onSubmit={this.handleSubmit}>
        <input
          autoComplete="off"
          type="text"
          className="search-top-input form-control"
          placeholder="Search ... Page Title (Path) and Content"
          name="q"
          value={this.state.keyword}
          onFocus={this.handleFocus}
          onBlur={this.handleBlur}
          onChange={this.handleChange}
        />
        <div className="input-group-append">
          {formClear}
          <button type="submit" className="btn btn-light">
            <i className="search-top-icon fa fa-search" />
          </button>
        </div>
      </form>
    )
  }
}
