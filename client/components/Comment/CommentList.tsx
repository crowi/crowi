import React, { FC } from 'react'
import CommentItem from './CommentItem'
import Crowi from 'client/util/Crowi'
import { Comment } from 'client/types/crowi'

interface Props {
  id?: string
  className?: string
  children?: React.ReactNode
  crowi: Crowi
  comments: Comment[]
  revisionId: string | null
}

const CommentList: FC<Props> = ({ crowi, comments, revisionId, ...props }) => {
  return (
    <div {...props}>
      {comments.map(comment => (
        <CommentItem key={comment._id} crowi={crowi} comment={comment} revisionId={revisionId} />
      ))}
    </div>
  )
}

export default CommentList
