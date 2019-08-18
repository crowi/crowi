import React, { FC } from 'react'
import CommentList from './CommentList'
import Icon from 'components/Common/Icon'
import Crowi from 'client/util/Crowi'
import { Comment } from 'client/types/crowi'

function NewerCommentList({ crowi, comments, revisionId }) {
  if (!comments.length) return null

  return (
    <>
      <CommentList className="collapse" id="page-comments-list-newer" crowi={crowi} comments={comments} revisionId={revisionId} />
      <a className="text-center" data-toggle="collapse" href="#page-comments-list-newer">
        <Icon name="chevron-double-up" /> Comments for Newer Revision <Icon name="chevron-double-up" />
      </a>
    </>
  )
}

function OlderCommentList({ crowi, comments, revisionId }) {
  if (!comments.length) return null

  return (
    <>
      <a className="text-center" data-toggle="collapse" href="#page-comments-list-older">
        <Icon name="chevron-double-down" /> Comments for Older Revision <Icon name="chevron-double-down" />
      </a>
      <CommentList className="collapse in" id="page-comments-list-older" crowi={crowi} comments={comments} revisionId={revisionId} />
    </>
  )
}

interface Props {
  crowi: Crowi
  comments: { newer: Comment[]; current: Comment[]; older: Comment[] }
  revisionId: string | null
}

const CommentLists: FC<Props> = ({ crowi, comments, revisionId }) => {
  const { newer, current, older } = comments
  return (
    <div className="page-comments-list">
      <NewerCommentList crowi={crowi} comments={newer} revisionId={revisionId} />
      <CommentList crowi={crowi} comments={current} revisionId={revisionId} />
      <OlderCommentList crowi={crowi} comments={older} revisionId={revisionId} />
    </div>
  )
}

export default CommentLists
