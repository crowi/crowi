import React, { useState, FC } from 'react'
import { Form, FormGroup, Input, Label, Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

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
      <ModalHeader toggle={toggle}>ユーザー情報を編集しますか?</ModalHeader>
      <ModalBody>
        <Form>
          <FormGroup>
            <Label>
              現在の名前: <code>{user.name}</code>
            </Label>
            <Input type="text" name="name" placeholder="新しい名前を入力してください" defaultValue={user.name} onChange={handleUserNameChange} />
          </FormGroup>
          <FormGroup>
            <Label>
              現在のメールアドレス: <code>{user.email}</code>
            </Label>
            <Input type="email" name="email" placeholder="新しいメールアドレスを入力してください" defaultValue={user.email} onChange={handleEmailChange} />
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button type="submit" color="primary" onClick={handleSubmit}>
          実行
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default UserEditModal
