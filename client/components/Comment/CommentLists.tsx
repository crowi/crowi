import React, { FC } from 'react'
import styled from 'styled-components'
import CommentList from './CommentList'
import Icon from 'components/Common/Icon'
import Crowi from 'client/util/Crowi'
import { Comment } from 'client/types/crowi'

const ToggleCommentList = styled.a`
  text-align: center;
  display: block;
  margin: 8px;
  font-size: 0.9em;
  color: #999;
`

function NewerCommentList({ crowi, comments, revisionId, openCommentDeleteModal }) {
  if (!comments.length) return null

  return (
    <>
      <CommentList
        className="collapse"
        id="page-comments-list-newer"
        crowi={crowi}
        comments={comments}
        revisionId={revisionId}
        openCommentDeleteModal={openCommentDeleteModal}
      />
      <a className="text-center" data-toggle="collapse" href="#page-comments-list-newer">
        <Icon name="chevronDoubleUp" /> Comments for Newer Revision <Icon name="chevronDoubleUp" />
      </a>
    </>
  )
}

function OlderCommentList({ crowi, comments, revisionId, openCommentDeleteModal }) {
  if (!comments.length) return null

  return (
    <>
      <a className="text-center" data-toggle="collapse" href="#page-comments-list-older">
        <Icon name="chevronDoubleDown" /> Comments for Older Revision <Icon name="chevronDoubleDown" />
      </a>
      <CommentList
        className="collapse in"
        id="page-comments-list-older"
        crowi={crowi}
        comments={comments}
        revisionId={revisionId}
        openCommentDeleteModal={openCommentDeleteModal}
      />
    </>
  )
}

interface Props {
  crowi: Crowi
  comments: { newer: Comment[]; current: Comment[]; older: Comment[] }
  revisionId: string | null
  openCommentDeleteModal: ({ id, page_id, body }: { id: string; page_id: string; body: string }) => void
}

const CommentLists: FC<Props> = ({ crowi, comments, revisionId, openCommentDeleteModal }) => {
  const { newer, current, older } = comments
  return (
    <div>
      <NewerCommentList crowi={crowi} comments={newer} revisionId={revisionId} openCommentDeleteModal={openCommentDeleteModal} />
      <CommentList crowi={crowi} comments={current} revisionId={revisionId} openCommentDeleteModal={openCommentDeleteModal} />
      <OlderCommentList crowi={crowi} comments={older} revisionId={revisionId} openCommentDeleteModal={openCommentDeleteModal} />
    </div>
  )
}

export default CommentLists
