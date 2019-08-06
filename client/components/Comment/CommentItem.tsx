import React, { FC } from 'react'
import UserPicture from 'components/User/UserPicture'
import CommentBody from './CommentBody'
import Crowi from 'client/util/Crowi'

interface Props {
  crowi: Crowi
  revisionId: string | null
  comment: Record<string, any>
}

const CommentItem: FC<Props> = ({ crowi, revisionId, comment }) => {
  const { revision, creator, comment: commentBody, createdAt } = comment
  const badgeType = revision === revisionId ? 'badge-primary' : 'badge-secondary'

  const classNames = ['page-comment']
  const me = crowi.getUser() || {}
  if (me.id === creator._id) {
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
        <CommentBody comment={commentBody} />
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

export default CommentItem
