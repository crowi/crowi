import React, { FC, useState } from 'react'
import { Input, Button } from 'reactstrap'

interface Props {
  posting: boolean
  message: string
  postComment: (comment: string) => Promise<void>
}

const CommentForm: FC<Props> = ({ posting, message, postComment }) => {
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

export default CommentForm
