import React, { FC } from 'react'
import CommentItem from './CommentItem'
import Crowi from 'client/util/Crowi'
import { CommonProps } from 'client/types/component'
import { Comment } from 'client/types/crowi'

type Props = CommonProps & {
  children?: React.ReactNode
  crowi: Crowi
  comments: Comment[]
  revisionId: string | null
}

const CommentList: FC<Props> = (props) => {
  const { crowi, comments, revisionId, ...others } = props

  return (
    <div {...others}>
      {comments.map((comment) => (
        <CommentItem key={comment._id} crowi={crowi} comment={comment} revisionId={revisionId} />
      ))}
    </div>
  )
}

export default CommentList
