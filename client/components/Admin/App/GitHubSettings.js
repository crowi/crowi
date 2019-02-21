import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Label, Input } from 'reactstrap'
import FormRow from '../FormRow'
import Tips from './Tips'

function GitHubSettings({ settingForm, update, alert = {} }) {
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
        <legend>GitHub 設定</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>
          GitHub プロジェクトの設定をすると、GitHub アカウントにコネクトして登録やログインが可能になります。<br />
          また、Organizationを指定した場合は、その組織に所属するアカウントのみがコネクトできるようになります。
        </Tips>

        <FormRow>
          <Label for="githubClientId">Client ID</Label>
          <Input id="githubClientId" value={clientId} onChange={e => setClientId(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="githubClientSecret">Client Secret</Label>
          <Input id="githubClientSecret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="githubOrganization">Organization</Label>
          <Input id="githubOrganization" value={organization} onChange={e => setOrganization(e.target.value)} />
        </FormRow>

        <FormRow>
          <Button color="primary">更新</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

GitHubSettings.propTypes = {
  settingForm: PropTypes.object.isRequired,
  update: PropTypes.func.isRequired,
}

export default GitHubSettings
