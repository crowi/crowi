import React, { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import CommentLists from './CommentLists'
import CommentForm from './CommentForm'

function useFetchComments(crowi, pageId, revisionId, revisionCreatedAt, isSharePage) {
  const [comments, setComments] = useState({ current: [], newer: [], older: [] })

  const fetchComments = async () => {
    if (isSharePage) return

    const { ok, comments } = await crowi.apiGet('/comments.get', { page_id: pageId })
    const [current, newer, older] = [[], [], []]
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

  return [comments, fetchComments]
}

function usePostComment(crowi, pageId, revisionId, fetchComments) {
  const [posting, setPosting] = useState(false)
  const [message, setMessage] = useState('')

  const postComment = async comment => {
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

  return [{ posting, message }, { postComment }]
}

function Comment({ crowi, pageId, revisionId, revisionCreatedAt, isSharePage }) {
  const [comments, fetchComments] = useFetchComments(crowi, pageId, revisionId, revisionCreatedAt, isSharePage)
  const [{ posting, message }, { postComment }] = usePostComment(crowi, pageId, revisionId, fetchComments)

  useEffect(() => {
    fetchComments()
  }, [])

  return (
    !isSharePage && (
      <div className="page-comments">
        <CommentForm posting={posting} message={message} postComment={postComment} />
        <CommentLists crowi={crowi} comments={comments} revisionId={revisionId} />
      </div>
    )
  )
}

Comment.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
  revisionId: PropTypes.string.isRequired,
  revisionCreatedAt: PropTypes.string.isRequired,
  isSharePage: PropTypes.bool.isRequired,
}

export default Comment
