import React, { useState, FC } from 'react'
import { Collapse, Form, FormGroup, FormText, Label, Input, CustomInput, Button, Row, Col } from 'reactstrap'
import { useTranslation } from 'react-i18next'

function useForm(invite) {
  const [emails, setEmails] = useState('')
  const [sendEmail, setSendEmail] = useState(true)

  const clearForm = () => {
    setEmails('')
    setSendEmail(false)
  }

  const onSubmit = (e) => {
    e.preventDefault()
    invite({ emails, sendEmail })
    clearForm()
  }

  return [
    { emails, sendEmail },
    { setEmails, setSendEmail, onSubmit },
  ] as const
}

interface Props {
  invite: ({ emails, sendEmail }: { emails: string; sendEmail: boolean }) => void
}

const InviteUserForm: FC<Props> = ({ invite }) => {
  const [t] = useTranslation()
  const [collapse, setCollapse] = useState(false)
  const [{ emails, sendEmail }, { setEmails, setSendEmail, onSubmit }] = useForm(invite)

  return (
    <>
      <p>
        <Button color="secondary" onClick={() => setCollapse(!collapse)}>
          {t('admin.user.invite.form.collapse')}
        </Button>
      </p>
      <Form onSubmit={onSubmit}>
        <Collapse isOpen={collapse}>
          <FormGroup>
            <Row>
              <Col xs={{ size: 2, offset: 1 }}>
                <Label for="emails">{t('admin.user.invite.form.email')}</Label>
              </Col>
              <Col xs="8">
                <Input
                  type="textarea"
                  id="emails"
                  placeholder={t('admin.user.invite.form.example')}
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                />
                <FormText color="muted">{t('admin.user.invite.form.description')}</FormText>
              </Col>
            </Row>
          </FormGroup>

          <FormGroup>
            <Row>
              <Col xs={{ size: 8, offset: 3 }}>
                <CustomInput
                  id="sendEmail"
                  type="checkbox"
                  label={t('admin.user.invite.form.checkbox')}
                  checked={sendEmail}
                  onChange={() => setSendEmail(!sendEmail)}
                  inline
                />
              </Col>
            </Row>
          </FormGroup>

          <FormGroup>
            <Row>
              <Col xs={{ size: 8, offset: 3 }}>
                <Button color="primary">{t('admin.user.invite.form.submit')}</Button>
              </Col>
            </Row>
          </FormGroup>
        </Collapse>
      </Form>
    </>
  )
}

export default InviteUserForm
