// @flow
import React from 'react';
type Props = { page: Object };

export default class PageListMeta extends React.Component {
  props: Props;
  isPortalPath(path) {
    if (path.match(/.*\/$/)) {
      return true
    }

    return false
  }

  render() {
    // TODO isPortal()
    const page = this.props.page

    // portal check
    let PortalLabel
    if (this.isPortalPath(page.path)) {
      PortalLabel = <span className="badge badge-info">PORTAL</span>
    }

    let CommentCount
    if (page.commentCount > 0) {
      CommentCount = (
        <span>
          <i className="fa fa-comment" />
          {page.commentCount}
        </span>
      )
    }

    let LikerCount
    if (page.liker.length > 0) {
      LikerCount = (
        <span>
          <i className="fa fa-thumbs-up" />
          {page.liker.length}
        </span>
      )
    }

    return (
      <span className="page-list-meta">
        {PortalLabel}
        {CommentCount}
        {LikerCount}
      </span>
    )
  }
}

PageListMeta.defaultProps = {
  page: {},
}
