import React from 'react'
import PropTypes from 'prop-types'

import CommentList from './CommentList'

function NewerCommentList({ crowi, comments, revisionId }) {
  if (!comments.length) return null

  return (
    <>
      <CommentList className="collapse" id="page-comments-list-newer" crowi={crowi} comments={comments} revisionId={revisionId} />
      <a className="text-center" data-toggle="collapse" href="#page-comments-list-newer">
        <i className="fa fa-angle-double-up" /> Comments for Newer Revision <i className="fa fa-angle-double-up" />
      </a>
    </>
  )
}

function OlderCommentList({ crowi, comments, revisionId }) {
  if (comments.length) return null

  return (
    <>
      <a className="text-center" data-toggle="collapse" href="#page-comments-list-older">
        <i className="fa fa-angle-double-down" /> Comments for Older Revision <i className="fa fa-angle-double-down" />
      </a>
      <CommentList className="collapse in" id="page-comments-list-older" crowi={crowi} comments={comments} revisionId={revisionId} />
    </>
  )
}

function CommentLists({ crowi, comments, revisionId }) {
  const { newer, current, older } = comments
  return (
    <div className="page-comments-list">
      <NewerCommentList crowi={crowi} comments={newer} revisionId={revisionId} />
      <CommentList crowi={crowi} comments={current} revisionId={revisionId} />
      <OlderCommentList crowi={crowi} comments={older} revisionId={revisionId} />
    </div>
  )
}

CommentLists.propTypes = {
  crowi: PropTypes.object.isRequired,
  comments: PropTypes.object.isRequired,
  revisionId: PropTypes.string.isRequired,
}

export default CommentLists
