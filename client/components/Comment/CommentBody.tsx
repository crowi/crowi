import React, { FC } from 'react'
import styled from 'styled-components'
import { CommonProps } from 'client/types/component'

const PageCommentBody = styled.div<Props>`
  padding: 8px 0;
  word-wrap: break-word;
`

type Props = CommonProps & {
  comment: string
}

const CommentBody: FC<Props> = (props) => {
  const { comment, ...others } = props

  return (
    <PageCommentBody {...others}>
      {comment.split(/(\r\n|\r|\n)/g).map((line, i) => (
        <React.Fragment key={i}>{/(\r\n|\r|\n)/.test(line) ? <br /> : line}</React.Fragment>
      ))}
    </PageCommentBody>
  )
}

export default CommentBody
