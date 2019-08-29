import React from 'react'
import Icon from 'components/Common/Icon'
import { Page } from 'client/types/crowi'

interface Props {
  page: Page
}

export default class PageListMeta extends React.Component<Props> {
  static defaultProps = { page: {} }

  isPortalPath(path: string) {
    if (path.match(/.*\/$/)) {
      return true
    }

    return false
  }

  bookmarkHighlightClass(count: number) {
    if (count > 20) {
      // TODO: dynamic??
      return 'page-list-bookmarkCount-amazing'
    }
    if (count > 10) {
      return 'page-list-bookmarkCount-high'
    }

    // else
    return ''
  }

  isPublic(page) {
    const GRANT_PUBLIC = 1
    const { grant } = page

    return !grant || grant == GRANT_PUBLIC
  }

  render() {
    // TODO isPortal()
    const page = this.props.page

    // portal check
    let portalLabel
    if (this.isPortalPath(page.path)) {
      portalLabel = <span className="badge badge-info">PORTAL</span>
    }

    let commentCount
    if (page.commentCount > 0) {
      commentCount = (
        <span>
          <Icon name="comment" />
          {page.commentCount}
        </span>
      )
    }

    let likerCount
    if (page.liker.length > 0) {
      likerCount = (
        <span>
          <Icon name="thumbUp" />
          {page.liker.length}
        </span>
      )
    }

    let bookmarkCount
    if (page.bookmarkCount && page.bookmarkCount > 0) {
      const bookmarkHighlightClass = this.bookmarkHighlightClass(page.bookmarkCount)
      bookmarkCount = (
        <span className={`page-list-bookmarkCount ${bookmarkHighlightClass}`}>
          <Icon name="star" />
          {page.bookmarkCount}
        </span>
      )
    }

    let lockIcon
    if (!this.isPublic(page)) {
      lockIcon = <Icon name="lock" />
    }

    return (
      <span className="page-list-meta">
        {portalLabel} {commentCount} {likerCount} {bookmarkCount} {lockIcon}
      </span>
    )
  }
}
