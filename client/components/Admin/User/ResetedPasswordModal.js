import React from 'react'
import PropTypes from 'prop-types'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

function ResetedPasswordModal({ isOpen, toggle, user = {}, password }) {
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

ResetedPasswordModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  toggle: PropTypes.func.isRequired,
}

export default ResetedPasswordModal
