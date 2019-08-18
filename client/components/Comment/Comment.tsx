import React, { FC, useState, useEffect } from 'react'
import CommentLists from './CommentLists'
import CommentForm from './CommentForm'
import Crowi from 'client/util/Crowi'
import { Comment as CommentType } from 'client/types/crowi'

function useFetchComments(crowi, pageId, revisionId, revisionCreatedAt, isSharePage) {
  const [comments, setComments] = useState<{
    current: CommentType[]
    newer: CommentType[]
    older: CommentType[]
  }>({ current: [], newer: [], older: [] })

  const fetchComments = async () => {
    if (isSharePage) return

    const { ok, comments }: { ok: boolean; comments: CommentType[] } = await crowi.apiGet('/comments.get', { page_id: pageId })
    const [current, newer, older]: [CommentType[], CommentType[], CommentType[]] = [[], [], []]
    if (ok) {
      comments.forEach(comment => {
        const { revision, createdAt } = comment
        const isCurrent = revision === revisionId
        const isNewer = Date.parse(createdAt) / 1000 > revisionCreatedAt

        const target = isCurrent ? current : isNewer ? newer : older
        target.push(comment)
      })
      setComments({ current, newer, older })
    }
  }

  return [comments, fetchComments] as const
}

function usePostComment(crowi, pageId, revisionId, fetchComments) {
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

interface Props {
  crowi: Crowi
  pageId: string | null
  revisionId: string | null
  revisionCreatedAt: string | null
  isSharePage: boolean
}

const Comment: FC<Props> = ({ crowi, pageId, revisionId, revisionCreatedAt, isSharePage }) => {
  const [comments, fetchComments] = useFetchComments(crowi, pageId, revisionId, revisionCreatedAt, isSharePage)
  const [{ posting, message }, { postComment }] = usePostComment(crowi, pageId, revisionId, fetchComments)

  useEffect(() => {
    fetchComments()
  }, [])

  return !isSharePage ? (
    <div className="page-comments">
      <CommentForm posting={posting} message={message} postComment={postComment} />
      <CommentLists crowi={crowi} comments={comments} revisionId={revisionId} />
    </div>
  ) : null
}

export default Comment
