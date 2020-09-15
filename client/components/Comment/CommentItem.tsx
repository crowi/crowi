import React, { FC, useMemo } from 'react'
import styled, { css } from 'styled-components'
import UserPicture from 'components/User/UserPicture'
import CommentBody from './CommentBody'
import * as styles from 'client/constants/styles'
import { CommonProps } from 'client/types/component'
import Crowi from 'client/util/Crowi'
import { formatToLocaleString, formatDistanceFromNow } from 'client/util/formatDate'
import Icon from 'components/Common/Icon'

type PageCommentContainerProps = Props & {
  isOwn: boolean
  isOld: boolean
}

const PageCommentContainer = styled.div<PageCommentContainerProps>`
  display: flex;
  margin-top: 8px;
  padding-top: 8px;
  border-top: solid 1px #ccc;

  ${({ isOwn }: PageCommentContainerProps) =>
    isOwn &&
    css`
      color: ${styles.header.background};
    `}

  ${({ isOld }: PageCommentContainerProps) =>
    isOld &&
    css`
      opacity: 0.7;

      &:hover {
        opacity: 1;
      }
    `}
`

const CommentUserPicture = styled(UserPicture)`
  width: 24px;
  height: 24px;
`

const PageComment = styled.div`
  margin-left: 16px;
`

const CommentCreator = styled.div`
  font-weight: bold;
`

const CommentMeta = styled.div`
  color: #aaa;
  font-size: 0.9em;
`

const CommentAt = styled.span`
  margin-right: 0.5em;
`

const Revision = styled.a`
  margin-right: 1em;
`

type Props = CommonProps & {
  crowi: Crowi
  revisionId: string | null
  comment: Record<string, any>
  openCommentDeleteModal: (state: any) => void
}

const CommentItem: FC<Props> = (props) => {
  const { crowi, revisionId, comment, openCommentDeleteModal, ...others } = props
  const { revision, creator, comment: commentBody, createdAt } = comment
  const badgeType = revision === revisionId ? 'badge-primary' : 'badge-secondary'

  const relativeCreatedAt = formatDistanceFromNow(createdAt)
  const absoluteCreatedAt = useMemo(() => formatToLocaleString(createdAt), [createdAt])

  const me = crowi.getUser() || {}

  return (
    <PageCommentContainer isOwn={me._id === creator._id} isOld={revision !== revisionId} {...others}>
      <CommentUserPicture user={creator} />
      <PageComment>
        <CommentCreator>{creator.username}</CommentCreator>
        <CommentBody comment={commentBody} />
        <CommentMeta>
          <CommentAt title={absoluteCreatedAt}>{relativeCreatedAt}</CommentAt>
          <Revision className={`badge ${badgeType}`} href={`?revision=${revision}`}>
            {revision.substr(0, 8)}
          </Revision>
          <a
            className="text-danger"
            onClick={() => {
              openCommentDeleteModal(commentBody)
            }}
          >
            <Icon name="trashCanOutline" />
          </a>
        </CommentMeta>
      </PageComment>
    </PageCommentContainer>
  )
}

export default CommentItem
