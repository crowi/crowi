import React, { FC } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

interface Props {
  isOpen: boolean
  toggle: () => void
  user: any
}

const UserEditModal: FC<Props> = ({ isOpen, toggle, user = {} }) => {
  const handleClick = (e) => {
    e.preventDefault()
    alert('編集！！！')
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>ユーザー情報を編集しますか?</ModalHeader>
      <ModalBody>
        <p>処理はこれから作ります。</p>
        <p>
          edited user: <code>{user.email}</code>
        </p>
      </ModalBody>
      <ModalFooter>
        <Button type="submit" color="primary" onClick={handleClick}>
          実行
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default UserEditModal
