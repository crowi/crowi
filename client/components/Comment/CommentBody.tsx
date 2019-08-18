import React, { FC } from 'react'

interface Props {
  comment: string
}

const CommentBody: FC<Props> = ({ comment }) => {
  return (
    <div className="page-comment-body">
      {comment.split(/(\r\n|\r|\n)/g).map((line, i) => (
        <React.Fragment key={i}>{/(\r\n|\r|\n)/.test(line) ? <br /> : line}</React.Fragment>
      ))}
    </div>
  )
}

export default CommentBody
