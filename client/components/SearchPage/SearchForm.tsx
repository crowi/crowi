import React from 'react'

interface Props {
  keyword: string
  onSearchFormChanged: Function
}

interface State {
  keyword: string
  searchedKeyword: string
}

// Search.SearchForm
export default class SearchForm extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      keyword: this.props.keyword,
      searchedKeyword: this.props.keyword,
    }

    this.handleSubmit = this.handleSubmit.bind(this)
    this.handleChange = this.handleChange.bind(this)
  }

  search() {
    const { searchedKeyword, keyword } = this.state
    if (searchedKeyword != keyword) {
      this.props.onSearchFormChanged({ keyword })
      this.setState({ searchedKeyword: keyword })
    }
  }

  handleSubmit(event) {
    event.preventDefault()
    this.search()
  }

  handleChange(event) {
    const keyword = event.target.value
    this.setState({ keyword })
  }

  render() {
    return (
      <form className="form form-group input-group" onSubmit={this.handleSubmit}>
        <input type="text" name="q" value={this.state.keyword} onChange={this.handleChange} className="form-control" />
        <span className="input-group-append">
          <button type="submit" className="btn btn-outline-secondary">
            <i className="search-top-icon fa fa-search" />
          </button>
        </span>
      </form>
    )
  }
}
