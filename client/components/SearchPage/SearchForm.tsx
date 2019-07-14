import React, { ChangeEvent } from 'react'
import Icon from 'components/Common/Icon'

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

  handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    this.search()
  }

  handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const keyword = event.target.value
    this.setState({ keyword })
  }

  render() {
    return (
      <form className="form form-group input-group" onSubmit={this.handleSubmit}>
        <input type="text" name="q" value={this.state.keyword} onChange={this.handleChange} className="form-control" />
        <span className="input-group-append">
          <button type="submit" className="btn btn-outline-secondary">
            <Icon name="magnify" />
          </button>
        </span>
      </form>
    )
  }
}
