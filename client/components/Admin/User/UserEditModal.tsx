import React, { useState, FC } from 'react'
import { Form, FormGroup, FormText, Input, Label, Modal, ModalHeader, ModalBody, ModalFooter, Button } from 'reactstrap'

function useForm(edit, id) {
  const [name, setName] = useState('')
  const [emailToBeChanged, setEmailToBeChanged] = useState('')

  const clearForm = () => {
    setName('')
    setEmailToBeChanged('')
  }

  const onSubmit = (e) => {
    e.preventDefault()
    edit({ name, emailToBeChanged, id })
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
  edit: ({ name, emailToBeChanged, id }: { name: string; emailToBeChanged: string; id: string }) => void
  user: any
}

const UserEditModal: FC<Props> = ({ isOpen, toggle, edit, user = {} }) => {
  const id = user._id
  const [{ name, emailToBeChanged }, { setName, setEmailToBeChanged, onSubmit }] = useForm(edit, id)

  const handleUserNameChange = (e) => {
    setName(e.target.value)
  }
  const handleEmailChange = (e) => {
    setEmailToBeChanged(e.target.value)
  }
  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>ユーザー情報を編集しますか?</ModalHeader>
      <ModalBody>
        <Form onSubmit={onSubmit}>
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
          <Button type="submit" color="primary">
            実行
          </Button>
        </Form>
      </ModalBody>
    </Modal>
  )
}

export default UserEditModal
