import React from 'react'
import PropTypes from 'prop-types'

import CommentItem from './CommentItem'

function CommentList({ crowi, comments, revisionId, ...props }) {
  return <div {...props}>{comments.map(comment => <CommentItem key={comment._id} crowi={crowi} comment={comment} revisionId={revisionId} />)}</div>
}

CommentList.propTypes = {
  comments: PropTypes.array.isRequired,
  revisionId: PropTypes.string.isRequired,
}

export default CommentList
