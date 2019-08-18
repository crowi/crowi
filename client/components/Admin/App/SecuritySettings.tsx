import React, { useState, FC } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Alert, Button, Label, Input, FormText, FormGroup, Row, Col } from 'reactstrap'
import FormRow from '../FormRow'

interface Props {
  settingForm: object
  registrationMode: string
  update: (settings: object) => void
  alert: {
    status: string
    show: boolean
    message: string
  }
}

const SecuritySettings: FC<Props> = ({ registrationMode: registrationModeOptions, settingForm, update, alert }) => {
  const [t] = useTranslation()
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
        <legend>{t('admin.security.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 1 }}>
              <Label>{t('admin.security.basic_auth')}</Label>
            </Col>
            <Col xs="3">
              <Label for="securityBasicName">{t('admin.security.id')}</Label>
              <Input id="securityBasicName" value={basicName} onChange={e => setBasicName(e.target.value)} />
            </Col>
            <Col xs="3">
              <Label for="securityBasicSecret">{t('admin.security.password')}</Label>
              <Input id="securityBasicSecret" value={basicSecret} onChange={e => setBasicSecret(e.target.value)} />
            </Col>
            <Col xs={{ size: 8, offset: 4 }}>
              <FormText color="muted">
                {t('admin.security.tips1')}
                <br />
                {t('admin.security.tips2')}
              </FormText>
            </Col>
          </Row>
        </FormGroup>

        <FormRow>
          <Label for="securityRegistrationMode">{t('admin.security.restriction')}</Label>
          <Input type="select" id="securityRegistrationMode" value={registrationMode} onChange={e => setRegistrationMode(e.target.value)}>
            {Object.entries(registrationModeOptions).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </Input>
          <FormText color="muted">{t('admin.security.restriction_description')}</FormText>
        </FormRow>

        <FormRow>
          <Label for="securityRegistrationWhiteList">{t('admin.security.whitelist')}</Label>
          <Input
            type="textarea"
            id="securityRegistrationWhiteList"
            placeholder={t('admin.security.whitelist_placeholder')}
            value={registrationWhiteList}
            onChange={e => setRegistrationWhiteList(e.target.value)}
          />
          <FormText color="muted">
            <Trans i18nKey="admin.security.whitelist_description1">
              登録可能なメールアドレスを制限することができます。例えば、会社で使う場合、<code>@crowi.wiki</code>
              などと記載すると、その会社のメールアドレスを持っている人のみ登録可能になります。
            </Trans>
            <br />
            {t('admin.security.whitelist_description2')}
          </FormText>
        </FormRow>

        <FormRow>
          <Button color="primary">{t('Update')}</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

export default SecuritySettings
