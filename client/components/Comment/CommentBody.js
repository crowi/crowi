import React from 'react'
import PropTypes from 'prop-types'

function CommentBody({ comment }) {
  return (
    <div className="page-comment-body">
      {comment.split(/(\r\n|\r|\n)/g).map((line, i) => <React.Fragment key={i}>{/(\r\n|\r|\n)/.test(line) ? <br /> : line}</React.Fragment>)}
    </div>
  )
}

CommentBody.propTypes = {
  comment: PropTypes.string.isRequired,
}

export default CommentBody
