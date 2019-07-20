import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import Crowi from 'client/util/Crowi'

import FormRow from '../FormRow'
import { Alert, Button, Label, Input } from 'reactstrap'

interface Props {
  crowi: Crowi
  slackSetting: object
  fetchSettings: () => void
}

const NotificationSettings: FC<Props> = ({ crowi, slackSetting, fetchSettings }) => {
  const [t] = useTranslation()
  const [clientId, setClientId] = useState(slackSetting['slack:clientId'])
  const [clientSecret, setClientSecret] = useState(slackSetting['slack:clientSecret'])
  const [alert, setAlert] = useState({ status: '', show: false, message: '' })

  const handleSubmit = async e => {
    e.preventDefault()

    try {
      const { message } = await crowi.apiPost('/admin/notification/slackSetting', {
        slackSetting: { 'slack:clientId': clientId, 'slack:clientSecret': clientSecret },
      })

      setAlert({ message, status: 'success', show: true })
    } catch ({ message }) {
      setAlert({ message, status: 'danger', show: true })
    } finally {
      setTimeout(() => setAlert({ status: '', show: false, message: '' }), 5000)
    }

    fetchSettings()
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.notification.settings.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormRow>
          <Label for="slackClientId">{t('admin.notification.settings.client_id')}</Label>
          <Input id="slackClientId" type="text" value={clientId} onChange={e => setClientId(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="slackClientSecret">{t('admin.notification.settings.client_secret')}</Label>
          <Input id="slackClientSecret" type="text" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
        </FormRow>

        <FormRow>
          <Button type="submit" color="primary">
            {t('Submit')}
          </Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

export default NotificationSettings
