import React, { FC } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

interface Props {
  isOpen: boolean
  toggle: () => void
  user: any
  resetPassword: (user: any) => void
}

const ResetPasswordModal: FC<Props> = ({ isOpen, toggle, user = {}, resetPassword }) => {
  const handleClick = e => {
    e.preventDefault()
    resetPassword(user)
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>パスワードを新規発行しますか?</ModalHeader>
      <ModalBody>
        <p>
          新規発行したパスワードはこの画面を閉じると二度と表示できませんのでご注意ください。
          <br />
          <span className="text-danger">新規発行したパスワードを、対象ユーザーへ連絡してください。</span>
        </p>
        <p>
          Reset user: <code>{user.email}</code>
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

export default ResetPasswordModal
