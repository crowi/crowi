import React from 'react'
import PropTypes from 'prop-types'

import UserPicture from 'components/User/UserPicture'

class CommentItem extends React.Component {
  renderBody(comment) {
    return comment.split(/(\r\n|\r|\n)/g).map((line, i, lines) => <React.Fragment key={i}>{/(\r\n|\r|\n)/.test(line) ? <br /> : line}</React.Fragment>)
  }

  render() {
    const { crowi, revisionId } = this.props
    const { revision, creator, comment, createdAt } = this.props.comment
    const badgeType = revision === revisionId ? 'badge-primary' : 'badge-secondary'

    const classNames = ['page-comment']
    const me = crowi.getUser().id
    if (me === creator._id) {
      classNames.push('page-comment-me')
    }
    if (revision !== revisionId) {
      classNames.push('page-comment-old')
    }

    return (
      <div className={classNames.join(' ')}>
        <UserPicture user={creator} />
        <div className="page-comment-main">
          <div className="page-comment-creator">{creator.username}</div>
          <div className="page-comment-body">{this.renderBody(comment)}</div>
          <div className="page-comment-meta">
            <span className="page-comment-at">{createdAt}</span>
            <a className={`page-comment-revision badge ${badgeType}`} href={`?revision=${revision}`}>
              {revision.substr(0, 8)}
            </a>
          </div>
        </div>
      </div>
    )
  }
}

CommentItem.propTypes = {
  crowi: PropTypes.object.isRequired,
  revisionId: PropTypes.string.isRequired,
  comment: PropTypes.object.isRequired,
}

export default CommentItem
