import React, { FC, useState, useEffect } from 'react'
import styled from 'styled-components'
import CommentLists from './CommentLists'
import CommentForm from './CommentForm'
import Crowi from 'client/util/Crowi'
import { CommonProps } from 'client/types/component'
import { Comment as CommentType } from 'client/types/crowi'

const PageComments = styled.div<Props>`
  margin: 8px 0 0 0;
`

function useFetchComments(crowi: Crowi, pageId: string | null, revisionId: string | null, revisionCreatedAt: string | null, isSharePage: boolean) {
  const [comments, setComments] = useState<{
    current: CommentType[]
    newer: CommentType[]
    older: CommentType[]
  }>({ current: [], newer: [], older: [] })

  const fetchComments = async () => {
    if (isSharePage) return
    if (!pageId) return

    const { ok, comments }: { ok: boolean; comments: CommentType[] } = await crowi.apiGet('/comments.get', { page_id: pageId })
    const [current, newer, older]: [CommentType[], CommentType[], CommentType[]] = [[], [], []]
    if (ok) {
      comments.forEach((comment) => {
        const { revision, createdAt } = comment
        const isCurrent = revision === revisionId
        const isNewer = Date.parse(createdAt) / 1000 > Number(revisionCreatedAt)

        const target = isCurrent ? current : isNewer ? newer : older
        target.push(comment)
      })
      setComments({ current, newer, older })
    }
  }

  return [comments, fetchComments] as const
}

function usePostComment(crowi: Crowi, pageId: string | null, revisionId: string | null, fetchComments: () => Promise<void>) {
  const [posting, setPosting] = useState(false)
  const [message, setMessage] = useState('')

  const postComment = async (comment: string) => {
    try {
      setPosting(true)
      const { ok, error } = await crowi.apiPost('/comments.add', {
        commentForm: {
          comment,
          page_id: pageId,
          revision_id: revisionId,
        },
      })
      if (ok) {
        setMessage('')
        fetchComments()
      } else {
        setMessage(error)
      }
    } catch (err) {
      setMessage(err.message)
    } finally {
      setPosting(false)
    }
  }

  return [{ posting, message }, { postComment }] as const
}

type Props = CommonProps & {
  crowi: Crowi
  pageId: string | null
  revisionId: string | null
  revisionCreatedAt: string | null
  isSharePage: boolean
}

const Comment: FC<Props> = (props) => {
  const { crowi, pageId, revisionId, revisionCreatedAt, isSharePage, ...others } = props
  const [comments, fetchComments] = useFetchComments(crowi, pageId, revisionId, revisionCreatedAt, isSharePage)
  const [{ posting, message }, { postComment }] = usePostComment(crowi, pageId, revisionId, fetchComments)

  useEffect(() => {
    fetchComments()
  }, [])

  return !isSharePage ? (
    <PageComments {...others}>
      <CommentForm posting={posting} message={message} postComment={postComment} />
      <CommentLists crowi={crowi} comments={comments} revisionId={revisionId} />
    </PageComments>
  ) : null
}

export default Comment
