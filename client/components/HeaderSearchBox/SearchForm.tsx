import React from 'react'
import Icon from 'components/Common/Icon'
import Emitter from '../../emitter'

interface Props {
  onSearchFormChanged: Function
  isShown: Function
  isSearchPage: boolean
  pollInterval?: number
  keyword: string
  focused: boolean
}

interface State {
  keyword: string
  searchedKeyword: string
}

// Header.SearchForm
export default class SearchForm extends React.Component<Props, State> {
  static defaultProps = { pollInterval: 1000 }

  ticker: number | undefined

  constructor(props: Props) {
    super(props)

    this.state = {
      keyword: props.keyword,
      searchedKeyword: '',
    }

    this.handleSubmit = this.handleSubmit.bind(this)
    this.handleChange = this.handleChange.bind(this)
    this.handleFocus = this.handleFocus.bind(this)
    this.clearForm = this.clearForm.bind(this)
  }

  componentDidMount() {
    this.ticker = window.setInterval(this.searchFieldTicker.bind(this), this.props.pollInterval)
  }

  componentWillUnmount() {
    window.clearInterval(this.ticker)
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
          <Icon name="close-circle" />
        </a>
      )
    } else {
      return ''
    }
  }

  clearForm() {
    this.setState({ keyword: '' })
    this.search()
  }

  searchFieldTicker() {
    this.search()
  }

  handleFocus(event: React.FocusEvent<HTMLInputElement>) {
    this.props.isShown(true)
  }

  handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const keyword = event.target.value
    this.setState({ keyword })
  }

  handleSubmit(e: React.FormEvent<HTMLFormElement>) {
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
        <div className="input-group-prepend">
          <span className="input-group-text">
            <Icon name="magnify" />
          </span>
        </div>
        {this.props.focused && formClear}
        <input
          autoComplete="off"
          type="text"
          className="search-top-input form-control"
          placeholder="Search ... Page title and content"
          name="q"
          value={this.state.keyword}
          onFocus={this.handleFocus}
          onChange={this.handleChange}
          style={{ maxWidth: this.props.focused ? 'none' : '200px' }}
        />
      </form>
    )
  }
}
