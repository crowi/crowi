import React, { FC } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'
import { useTranslation } from 'react-i18next'

interface Props {
  isOpen: boolean
  toggle: () => void
  user: any
  resetPassword: (user: any) => void
}

const ResetPasswordModal: FC<Props> = ({ isOpen, toggle, user = {}, resetPassword }) => {
  const [t] = useTranslation()
  const handleClick = (e) => {
    e.preventDefault()
    resetPassword(user)
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>{t('admin.user.reset_password.modal.ask')}</ModalHeader>
      <ModalBody>
        <p>
          {t('admin.user.reset_password.modal.caution')}
          <br />
          <span className="text-danger">{t('admin.user.reset_password.modal.after_reset')}</span>
        </p>
        <p>
          Reset user: <code>{user.email}</code>
        </p>
      </ModalBody>
      <ModalFooter>
        <Button type="submit" color="primary" onClick={handleClick}>
          {t('admin.user.reset_password.modal.submit')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default ResetPasswordModal
