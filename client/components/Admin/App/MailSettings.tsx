import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Label, Input, FormGroup, Row, Col } from 'reactstrap'
import FormRow from '../FormRow'
import Tips from './Tips'

interface Props {
  settingForm: object
  update: (settings: object) => void
  alert: {
    status: string
    show: boolean
    message: string
  }
}

const MailSettings: FC<Props> = ({ settingForm, update, alert }) => {
  const [t] = useTranslation()
  const [mail, setMail] = useState(settingForm['mail:from'])
  const [host, setHost] = useState(settingForm['mail:smtpHost'] || '')
  const [port, setPort] = useState(settingForm['mail:smtpPort'] || '')
  const [user, setUser] = useState(settingForm['mail:smtpUser'] || '')
  const [password, setPassword] = useState(settingForm['mail:smtpPassword'] || '')

  const handleSubmit = e => {
    e.preventDefault()
    update({
      'mail:from': mail,
      'mail:smtpHost': host,
      'mail:smtpPort': port,
      'mail:smtpUser': user,
      'mail:smtpPassword': password,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.mail.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>
          {t('admin.mail.tips1')}
          <br />
          {t('admin.mail.tips2')}
        </Tips>

        <FormRow>
          <Label for="mailFrom">{t('admin.mail.from')}</Label>
          <Input id="mailFrom" placeholder={t('admin.mail.from_placeholder')} value={mail} onChange={e => setMail(e.target.value)} />
        </FormRow>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 1 }}>
              <Label>{t('admin.mail.smtp')}</Label>
            </Col>
            <Col xs="4">
              <Label for="mailSmtpHost">{t('admin.mail.host')}</Label>
              <Input id="mailSmtpHost" value={host} onChange={e => setHost(e.target.value)} />
            </Col>
            <Col xs="2">
              <Label for="mailSmtpPort">{t('admin.mail.port')}</Label>
              <Input id="mailSmtpPort" value={port} onChange={e => setPort(e.target.value)} />
            </Col>
          </Row>
        </FormGroup>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 4 }}>
              <Label for="mailSmtpUser">{t('admin.mail.user')}</Label>
              <Input id="mailSmtpUser" value={user} onChange={e => setUser(e.target.value)} />
            </Col>
            <Col xs="3">
              <Label for="mailSmtpPassword">{t('admin.mail.password')}</Label>
              <Input type="password" id="mailSmtpPassword" value={password} onChange={e => setPassword(e.target.value)} />
            </Col>
          </Row>
        </FormGroup>

        <FormRow>
          <Button color="primary">{t('Update')}</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

export default MailSettings
