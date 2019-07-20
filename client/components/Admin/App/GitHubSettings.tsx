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

const GitHubSettings: FC<Props> = ({ settingForm, update, alert }) => {
  const [t] = useTranslation()
  const [clientId, setClientId] = useState(settingForm['github:clientId'])
  const [clientSecret, setClientSecret] = useState(settingForm['github:clientSecret'])
  const [organization, setOrganization] = useState(settingForm['github:organization'])

  const handleSubmit = e => {
    e.preventDefault()
    update({
      'github:clientId': clientId,
      'github:clientSecret': clientSecret,
      'github:organization': organization,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.github.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>
          {t('admin.github.tips1')}
          <br />
          {t('admin.github.tips2')}
        </Tips>

        <FormRow>
          <Label for="githubClientId">{t('admin.github.client_id')}</Label>
          <Input id="githubClientId" value={clientId} onChange={e => setClientId(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="githubClientSecret">{t('admin.github.client_secret')}</Label>
          <Input id="githubClientSecret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="githubOrganization">{t('admin.github.organization')}</Label>
          <Input id="githubOrganization" value={organization} onChange={e => setOrganization(e.target.value)} />
        </FormRow>

        <FormRow>
          <Button color="primary">{t('Update')}</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

export default GitHubSettings
