import React, { FC, useState } from 'react'
import styled from 'styled-components'
import { Input, Button } from 'reactstrap'
import { CommonProps } from 'client/types/component'

const PageCommentForm = styled.div<Props>`
  margin-top: 16px;
`

const CommentInput = styled(Input)`
  height: 60px;
`

const CommentSubmit = styled.div`
  margin-top: 8px;
  text-align: right;
`

type Props = CommonProps & {
  posting: boolean
  message: string
  postComment: (comment: string) => Promise<void>
}

const CommentForm: FC<Props> = (props) => {
  const { posting, message, postComment, ...others } = props
  const [comment, setComment] = useState('')

  const onClick = () => {
    postComment(comment)
    setComment('')
  }

  return (
    <PageCommentForm className="form" {...others}>
      <CommentInput type="textarea" value={comment} onChange={(e) => setComment(e.target.value)} />
      <CommentSubmit>
        <span className="text-danger">{message}</span>
        <Button color="primary" size="sm" onClick={onClick} disabled={posting}>
          Comment
        </Button>
      </CommentSubmit>
    </PageCommentForm>
  )
}

export default CommentForm
