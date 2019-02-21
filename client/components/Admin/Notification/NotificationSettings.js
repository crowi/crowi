import React, { useState } from 'react'
import PropTypes from 'prop-types'

import FormRow from '../FormRow'
import { Alert, Button, Label, Input } from 'reactstrap'

function NotificationSettings({ slackSetting, fetchSettings }) {
  const [clientId, setClientId] = useState(slackSetting['slack:clientId'])
  const [clientSecret, setClientSecret] = useState(slackSetting['slack:clientSecret'])
  const [alert, setAlert] = useState({})

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
      setTimeout(() => setAlert({}), 5000)
    }

    fetchSettings()
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Slack App Configuration</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormRow>
          <Label for="slackClientId">Client ID</Label>
          <Input id="slackClientId" type="text" value={clientId} onChange={e => setClientId(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="slackClientSecret">Client Secret</Label>
          <Input id="slackClientSecret" type="text" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
        </FormRow>

        <FormRow>
          <Button type="submit" color="primary">
            Submit
          </Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

NotificationSettings.propTypes = {
  slackSetting: PropTypes.object.isRequired,
}

export default NotificationSettings
