import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Label, Input, FormText, FormGroup, Row, Col } from 'reactstrap'
import FormRow from '../FormRow'

function SecuritySettings({ registrationMode: registrationModeOptions, settingForm, update, alert = {} }) {
  const [basicName, setBasicName] = useState(settingForm['security:basicName'] || '')
  const [basicSecret, setBasicSecret] = useState(settingForm['security:basicSecret'] || '')
  const [registrationMode, setRegistrationMode] = useState(settingForm['security:registrationMode'] || '')
  const [registrationWhiteList, setRegistrationWhiteList] = useState(settingForm['security:registrationWhiteList'])

  const handleSubmit = e => {
    e.preventDefault()
    update({
      'security:basicName': basicName,
      'security:basicSecret': basicSecret,
      'security:registrationMode': registrationMode,
      'security:registrationWhiteList': registrationWhiteList,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>セキュリティ設定</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 1 }}>
              <Label>Basic認証</Label>
            </Col>
            <Col xs="3">
              <Label for="securityBasicName">ID</Label>
              <Input id="securityBasicName" value={basicName} onChange={e => setBasicName(e.target.value)} />
            </Col>
            <Col xs="3">
              <Label for="securityBasicSecret">パスワード</Label>
              <Input id="securityBasicSecret" value={basicSecret} onChange={e => setBasicSecret(e.target.value)} />
            </Col>
            <Col xs={{ size: 8, offset: 4 }}>
              <FormText color="muted">
                Basic認証を設定すると、ページ全体に共通の認証がかかります。<br />
                IDとパスワードは暗号化されずに送信されるのでご注意下さい。
              </FormText>
            </Col>
          </Row>
        </FormGroup>

        <FormRow>
          <Label for="securityRegistrationMode">登録の制限</Label>
          <Input type="select" id="securityRegistrationMode" value={registrationMode} onChange={e => setRegistrationMode(e.target.value)}>
            {Object.entries(registrationModeOptions).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </Input>
          <FormText color="muted">ここに入力した内容は、ヘッダー等に表示されます。</FormText>
        </FormRow>

        <FormRow>
          <Label for="securityRegistrationWhiteList">
            登録許可メールアドレスの<br />ホワイトリスト
          </Label>
          <Input
            type="textarea"
            id="securityRegistrationWhiteList"
            placeholder="例: @crowi.wiki"
            value={registrationWhiteList}
            onChange={e => setRegistrationWhiteList(e.target.value)}
          />
          <FormText color="muted">
            登録可能なメールアドレスを制限することができます。例えば、会社で使う場合、<code>@crowi.wiki</code>{' '}
            などと記載すると、その会社のメールアドレスを持っている人のみ登録可能になります。<br />
            1行に1メールアドレス入力してください。
          </FormText>
        </FormRow>

        <FormRow>
          <Button color="primary">更新</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

SecuritySettings.propTypes = {
  settingForm: PropTypes.object.isRequired,
  registrationMode: PropTypes.object.isRequired,
  update: PropTypes.func.isRequired,
}

export default SecuritySettings
