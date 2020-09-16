import React, { useState, FC } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

interface Props {
  isOpen: boolean
  toggle: () => void
  comment: any
  deleteComment: (commentId: any) => void
}

const CommentDeleteModal: FC<Props> = ({ isOpen, toggle, comment, deleteComment }) => {
  const handleSubmit = (e) => {
    e.preventDefault()
    deleteComment(comment)
    toggle()
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>本当にこのコメントを削除しますか?</ModalHeader>
      <ModalBody>
        <p>削除対象のコメント: {comment}</p>
      </ModalBody>
      <ModalFooter>
        <Button type="submit" color="danger" onClick={handleSubmit}>
          実行
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default CommentDeleteModal
