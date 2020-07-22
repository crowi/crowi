import React, { useState, FC } from 'react'
import { Form, FormGroup, FormText, Input, Label, Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

function useForm(edit, currentEmail) {
  const [name, setName] = useState('')
  const [emailToBeChanged, setEmailToBeChanged] = useState('')

  const clearForm = () => {
    setName('')
    setEmailToBeChanged('')
  }

  const onSubmit = (e) => {
    e.preventDefault()
    edit({ name, emailToBeChanged, currentEmail })
    clearForm()
  }

  return [
    { name, emailToBeChanged },
    { setName, setEmailToBeChanged, onSubmit },
  ] as const
}

interface Props {
  isOpen: boolean
  toggle: () => void
  edit: ({ name, emailToBeChanged, currentEmail }: { name: string; emailToBeChanged: string; currentEmail: string }) => void
  user: any
}

const UserEditModal: FC<Props> = ({ isOpen, toggle, edit, user = {} }) => {
  const currentEmail = user.email
  const [{ name, emailToBeChanged }, { setName, setEmailToBeChanged, onSubmit }] = useForm(edit, currentEmail)

  const handleUserNameChange = (e) => {
    setName(e.target.value)
  }
  const handleEmailChange = (e) => {
    setEmailToBeChanged(e.target.value)
  }
  const handleSubmit = (e) => {
    edit({ name, emailToBeChanged, currentEmail })
    alert(`${name} + ${emailToBeChanged}`)
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
            <Input type="text" name="name" placeholder="Please enter your new user name" onChange={handleUserNameChange} />
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
