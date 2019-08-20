import React, { FC } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

interface Props {
  isOpen: boolean
  toggle: () => void
  user: any
  password: string
}

const ResetedPasswordModal: FC<Props> = ({ isOpen, toggle, user = {}, password }) => {
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>Password reset!</ModalHeader>

      <ModalBody>
        <p className="alert alert-danger">Let the user know the new password below and strongly recommend to change another one immediately. </p>
        <p>
          Reset user: <code>{user.email}</code>
        </p>
        <p>
          New password: <code>{password}</code>
        </p>
      </ModalBody>
      <ModalFooter>
        <Button color="primary" onClick={toggle}>
          OK
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default ResetedPasswordModal
