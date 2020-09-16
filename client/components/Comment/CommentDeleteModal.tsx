import React, { useState, FC } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

interface Props {
  isOpen: boolean
  toggle: () => void
  comment: { id: any; body: string }
  deleteComment: (commentId: any) => void
}

const CommentDeleteModal: FC<Props> = ({ isOpen, toggle, comment, deleteComment }) => {
  const handleSubmit = (e) => {
    e.preventDefault()
    deleteComment(comment.id)
    toggle()
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>本当にこのコメントを削除しますか?</ModalHeader>
      <ModalBody>
        <p>{comment.body}</p>
      </ModalBody>
      <ModalFooter>
        <Button type="submit" color="danger" onClick={handleSubmit}>
          削除
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default CommentDeleteModal
