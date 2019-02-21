import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Input, Button } from 'reactstrap'

function CommentForm({ posting, message, postComment }) {
  const [comment, setComment] = useState('')

  const onClick = () => {
    postComment(comment)
    setComment('')
  }

  return (
    <div className="form page-comment-form">
      <div className="comment-form">
        <div className="comment-form-main">
          <Input type="textarea" value={comment} onChange={e => setComment(e.target.value)} />
          <div className="comment-submit">
            <span className="text-danger">{message}</span>
            <Button color="primary" size="sm" onClick={onClick} disabled={posting}>
              Comment
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

CommentForm.propTypes = {
  posting: PropTypes.bool.isRequired,
  message: PropTypes.string.isRequired,
  postComment: PropTypes.func.isRequired,
}

export default CommentForm
