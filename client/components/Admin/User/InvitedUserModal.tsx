import React, { FC } from 'react'
import { Modal, ModalHeader, ModalBody, Table } from 'reactstrap'
import { useTranslation } from 'react-i18next'

interface Props {
  users: any[]
  clear: () => void
}

const InvitedUserModal: FC<Props> = ({ users, clear }) => {
  const [t] = useTranslation()
  return (
    <Modal isOpen={users.length > 0} toggle={clear}>
      <ModalHeader toggle={clear}>{t('admin.user.invite.modal.completed_message')}</ModalHeader>
      <ModalBody>
        <p>
          {t('admin.user.invite.modal.temp_password')}
          <br />
          {t('admin.user.invite.modal.caution_password')}
          <br />
          <span className="text-danger">{t('admin.user.invite.modal.caution_without_email')}</span>
        </p>
        <Table>
          <thead>
            <tr>
              <th>{t('admin.user.invite.modal.email')}</th>
              <th>{t('admin.user.invite.modal.password')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map(({ user, email, password }) => (
              <tr key={email}>
                <td>
                  <pre>{email}</pre>
                </td>
                <td>{user ? <pre>{password}</pre> : <span className="text-danger">{t('admin.user.invite.modal.failed_message')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </ModalBody>
    </Modal>
  )
}

export default InvitedUserModal
