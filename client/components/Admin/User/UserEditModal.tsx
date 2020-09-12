import React, { useState, FC } from 'react'
import { Form, FormGroup, Input, Label, Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'
import { useTranslation } from 'react-i18next'

interface Props {
  isOpen: boolean
  toggle: () => void
  editUserNameAndEmail: ({ name, emailToBeChanged, user }: { name: string; emailToBeChanged: string; user: any }) => void
  clearForm: () => void
  name: string
  emailToBeChanged: string
  setName: (name) => void
  setEmailToBeChanged: (emailToBeChanged) => void
  user: any
}

const UserEditModal: FC<Props> = ({ isOpen, toggle, editUserNameAndEmail, clearForm, name, emailToBeChanged, setName, setEmailToBeChanged, user = {} }) => {
  const [t] = useTranslation()
  const handleUserNameChange = (e) => {
    setName(e.target.value)
  }
  const handleEmailChange = (e) => {
    setEmailToBeChanged(e.target.value)
  }
  const handleSubmit = (e) => {
    e.preventDefault()
    editUserNameAndEmail({ name, emailToBeChanged, user })
    clearForm()
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>{t('admin.user.edit.modal.ask')}</ModalHeader>
      <ModalBody>
        <Form>
          <FormGroup>
            <Label>
              {t('admin.user.edit.modal.current_name')}: <code>{user.name}</code>
            </Label>
            <Input type="text" name="name" placeholder={t('admin.user.edit.modal.new_name')} defaultValue={user.name} onChange={handleUserNameChange} />
          </FormGroup>
          <FormGroup>
            <Label>
              {t('admin.user.edit.modal.current_email')}: <code>{user.email}</code>
            </Label>
            <Input type="email" name="email" placeholder={t('admin.user.edit.modal.new_email')} defaultValue={user.email} onChange={handleEmailChange} />
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button type="submit" color="primary" onClick={handleSubmit}>
          {t('admin.user.edit.modal.submit')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default UserEditModal
