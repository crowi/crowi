import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Label, Input, FormGroup, Row, Col } from 'reactstrap'
import FormRow from '../FormRow'
import Tips from './Tips'

function MailSettings({ settingForm, update, alert = {} }) {
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
        <legend>メールの設定</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>
          SMTPの設定がされている場合、それが利用されます。SMTP設定がなく、AWSの設定がある場合、SESでの送信を試みます。<br />どちらの設定もない場合、メールは送信されません。
        </Tips>

        <FormRow>
          <Label for="mailFrom">Fromアドレス</Label>
          <Input id="mailFrom" placeholder="例: mail@crowi.wiki" value={mail} onChange={e => setMail(e.target.value)} />
        </FormRow>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 1 }}>
              <Label>SMTP設定</Label>
            </Col>
            <Col xs="4">
              <Label for="mailSmtpHost">ホスト</Label>
              <Input id="mailSmtpHost" value={host} onChange={e => setHost(e.target.value)} />
            </Col>
            <Col xs="2">
              <Label for="mailSmtpPort">ポート</Label>
              <Input id="mailSmtpPort" value={port} onChange={e => setPort(e.target.value)} />
            </Col>
          </Row>
        </FormGroup>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 4 }}>
              <Label for="mailSmtpUser">ユーザー</Label>
              <Input id="mailSmtpUser" value={user} onChange={e => setUser(e.target.value)} />
            </Col>
            <Col xs="3">
              <Label for="mailSmtpPassword">パスワード</Label>
              <Input type="password" id="mailSmtpPassword" value={password} onChange={e => setPassword(e.target.value)} />
            </Col>
          </Row>
        </FormGroup>

        <FormRow>
          <Button color="primary">更新</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

MailSettings.propTypes = {
  settingForm: PropTypes.object.isRequired,
  update: PropTypes.func.isRequired,
}

export default MailSettings
