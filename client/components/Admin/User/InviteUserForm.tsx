import React, { useState, FC } from 'react'
import { Collapse, Form, FormGroup, FormText, Label, Input, CustomInput, Button, Row, Col } from 'reactstrap'

function useForm(invite) {
  const [emails, setEmails] = useState('')
  const [sendEmail, setSendEmail] = useState(true)

  const clearForm = () => {
    setEmails('')
    setSendEmail(false)
  }

  const onSubmit = e => {
    e.preventDefault()
    invite({ emails, sendEmail })
    clearForm()
  }

  return [{ emails, sendEmail }, { setEmails, setSendEmail, onSubmit }] as const
}

interface Props {
  invite: ({ emails, sendEmail }: { emails: string; sendEmail: boolean }) => void
}

const InviteUserForm: FC<Props> = ({ invite }) => {
  const [collapse, setCollapse] = useState(false)
  const [{ emails, sendEmail }, { setEmails, setSendEmail, onSubmit }] = useForm(invite)

  return (
    <>
      <p>
        <Button color="secondary" onClick={() => setCollapse(!collapse)}>
          新規ユーザーの招待
        </Button>
      </p>
      <Form onSubmit={onSubmit}>
        <Collapse isOpen={collapse}>
          <FormGroup>
            <Row>
              <Col xs={{ size: 2, offset: 1 }}>
                <Label for="emails">メールアドレス</Label>
              </Col>
              <Col xs="8">
                <Input type="textarea" id="emails" placeholder="例: user@crowi.wiki" value={emails} onChange={e => setEmails(e.target.value)} />
                <FormText color="muted">複数行入力で複数人招待可能</FormText>
              </Col>
            </Row>
          </FormGroup>

          <FormGroup>
            <Row>
              <Col xs={{ size: 8, offset: 3 }}>
                <CustomInput id="sendEmail" type="checkbox" label="招待をメールで送信" checked={sendEmail} onChange={() => setSendEmail(!sendEmail)} inline />
              </Col>
            </Row>
          </FormGroup>

          <FormGroup>
            <Row>
              <Col xs={{ size: 8, offset: 3 }}>
                <Button color="primary">招待する</Button>
              </Col>
            </Row>
          </FormGroup>
        </Collapse>
      </Form>
    </>
  )
}

export default InviteUserForm
