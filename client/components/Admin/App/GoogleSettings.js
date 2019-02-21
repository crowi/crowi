import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Label, Input } from 'reactstrap'
import FormRow from '../FormRow'
import Tips from './Tips'

function GoogleSettings({ settingForm, update, alert = {} }) {
  const [clientId, setClientId] = useState(settingForm['google:clientId'])
  const [clientSecret, setClientSecret] = useState(settingForm['google:clientSecret'])

  const handleSubmit = e => {
    e.preventDefault()
    update({
      'google:clientId': clientId,
      'google:clientSecret': clientSecret,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Google 設定</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>Google プロジェクトの設定をすると、Google アカウントにコネクトして登録やログインが可能になります。</Tips>

        <FormRow>
          <Label for="googleClientId">Client ID</Label>
          <Input id="googleClientId" value={clientId} onChange={e => setClientId(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="googleClientSecret">Client Secret</Label>
          <Input id="googleClientSecret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
        </FormRow>

        <FormRow>
          <Button color="primary">更新</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

GoogleSettings.propTypes = {
  settingForm: PropTypes.object.isRequired,
  update: PropTypes.func.isRequired,
}

export default GoogleSettings
