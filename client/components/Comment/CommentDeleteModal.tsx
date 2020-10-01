import React, { useState, FC } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'
import { useTranslation } from 'react-i18next'

interface Props {
  isOpen: boolean
  toggle: () => void
  comment: { id: string; page_id: string; body: string }
  deleteComment: (comment_id: string, page_id: string) => void
}

const CommentDeleteModal: FC<Props> = ({ isOpen, toggle, comment, deleteComment }) => {
  const [t] = useTranslation()
  const handleSubmit = (e) => {
    e.preventDefault()
    deleteComment(comment.id, comment.page_id)
    toggle()
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>{t('comment.delete_modal_message')}</ModalHeader>
      <ModalBody>
        <p>{comment.body}</p>
      </ModalBody>
      <ModalFooter>
        <Button type="submit" color="danger" onClick={handleSubmit}>
          {t('comment.delete')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default CommentDeleteModal
