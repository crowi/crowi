import React from 'react'
import styled from 'styled-components'
import Icon from 'components/Common/Icon'
import Crowi from 'client/util/Crowi'

const BookmarkButtonLink = styled.a<Props>`
  color: #e6b422;
  font-size: 2em;
  line-height: 1;

  &:hover {
    color: #e6b422;
  }
`

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
    this.props.crowi.apiGet('/bookmarks.get', { page_id: this.props.pageId }).then((res) => {
      if (res.bookmark) {
        this.markBookmarked()
      }
    })
  }

  handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()

    const pageId = this.props.pageId

    if (!this.state.bookmarked) {
      this.props.crowi.apiPost('/bookmarks.add', { page_id: pageId }).then((res) => {
        this.markBookmarked()
      })
    } else {
      this.props.crowi.apiPost('/bookmarks.remove', { page_id: pageId }).then((res) => {
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
    const bookmarked: 'star' | 'starOutline' = this.state.bookmarked ? 'star' : 'starOutline'

    return (
      <BookmarkButtonLink href="#" title="Bookmark" onClick={this.handleClick}>
        <Icon name={bookmarked} />
      </BookmarkButtonLink>
    )
  }
}
