import React, { useState, FC } from 'react'
import { Form, FormGroup, FormText, Input, Label, Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

interface Props {
  isOpen: boolean
  toggle: () => void
  edit: () => void
  user: any
}

const UserEditModal: FC<Props> = ({ isOpen, toggle, edit, user = {} }) => {
  const [userName, setUserName] = useState()
  const [email, setEmail] = useState()

  const handleUserNameChange = (e) => {
    setUserName(e.target.value)
  }
  const handleEmailChange = (e) => {
    setEmail(e.target.value)
  }
  const handleSubmit = (e) => {
    edit()
    alert(`${userName} + ${email}`)
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>ユーザー情報を編集しますか?</ModalHeader>
      <ModalBody>
        <Form onSubmit={handleSubmit}>
          <FormGroup>
            <Label>
              現在のなまえ: <code>{user.name}</code>
            </Label>
            <Input type="text" name="userName" placeholder="Please enter your new user name" onChange={handleUserNameChange} />
          </FormGroup>
          <FormGroup>
            <Label>
              現在のメールアドレス: <code>{user.email}</code>
            </Label>
            <Input type="email" name="email" placeholder="Please enter your new email address" onChange={handleEmailChange} />
          </FormGroup>
          <Button type="submit" color="primary">
            実行
          </Button>
        </Form>
      </ModalBody>
    </Modal>
  )
}

export default UserEditModal
