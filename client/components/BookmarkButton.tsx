import React from 'react'
import { InputGroup, InputGroupAddon, InputGroupText, Button } from 'reactstrap'
import Icon from 'components/Common/Icon'
import Crowi from 'client/util/Crowi'

interface Props {
  crowi: Crowi
  pageId: string | null
}

interface State {
  bookmarked: boolean
}

export default class BookmarkButton extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      bookmarked: false,
    }

    this.handleClick = this.handleClick.bind(this)
  }

  componentDidMount() {
    this.props.crowi.apiGet('/bookmarks.get', { page_id: this.props.pageId }).then(res => {
      if (res.bookmark) {
        this.markBookmarked()
      }
    })
  }

  handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()

    const pageId = this.props.pageId

    if (!this.state.bookmarked) {
      this.props.crowi.apiPost('/bookmarks.add', { page_id: pageId }).then(res => {
        this.markBookmarked()
      })
    } else {
      this.props.crowi.apiPost('/bookmarks.remove', { page_id: pageId }).then(res => {
        this.markUnBookmarked()
      })
    }
  }

  markBookmarked() {
    this.setState({ bookmarked: true })
  }

  markUnBookmarked() {
    this.setState({ bookmarked: false })
  }

  render() {
    const { bookmarked } = this.state
    let bookmarkedIconStyle = '-outline'
    let bookmarkedButtonStyle = {}
    if (bookmarked) {
      bookmarkedIconStyle = ''
      bookmarkedButtonStyle = { color: '#e6b422' }
    }

    return (
      <InputGroup size="sm" className="input-group">
        <InputGroupAddon addonType="prepend">
          <Button outline color="primary" className="bookmark-link" onClick={this.handleClick} style={bookmarkedButtonStyle}>
            <Icon name={`star${bookmarkedIconStyle}`} />
          </Button>
        </InputGroupAddon>
        <InputGroupAddon addonType="append">
          <InputGroupText>32</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    )
  }
}
