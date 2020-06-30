import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Label, Input } from 'reactstrap'
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

const GoogleSettings: FC<Props> = ({ settingForm, update, alert }) => {
  const [t] = useTranslation()
  const [clientId, setClientId] = useState(settingForm['google:clientId'])
  const [clientSecret, setClientSecret] = useState(settingForm['google:clientSecret'])

  const handleSubmit = (e) => {
    e.preventDefault()
    update({
      'google:clientId': clientId,
      'google:clientSecret': clientSecret,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.google.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>{t('admin.google.tips')}</Tips>

        <FormRow>
          <Label for="googleClientId">{t('admin.google.client_id')}</Label>
          <Input id="googleClientId" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="googleClientSecret">{t('admin.google.client_secret')}</Label>
          <Input id="googleClientSecret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        </FormRow>

        <FormRow>
          <Button color="primary">{t('Update')}</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

export default GoogleSettings
