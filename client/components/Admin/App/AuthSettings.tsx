import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, FormText, CustomInput } from 'reactstrap'
import FormRow from '../FormRow'

interface Props {
  settingForm: object
  update: (settings: object) => void
  alert: {
    status: string
    show: boolean
    message: string
  }
}

const AuthSettings: FC<Props> = ({ settingForm, update, alert }) => {
  const [t] = useTranslation()
  const [requireThirdPartyAuth, setRequireThirdPartyAuth] = useState(!!settingForm['auth:requireThirdPartyAuth'])
  const [disablePasswordAuth, setDisablePasswordAuth] = useState(!!settingForm['auth:disablePasswordAuth'])

  const handleSubmit = (e) => {
    e.preventDefault()
    update({
      'auth:requireThirdPartyAuth': requireThirdPartyAuth,
      'auth:disablePasswordAuth': disablePasswordAuth,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.auth.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormRow>
          <CustomInput
            type="checkbox"
            id="requireThirdPartyAuth"
            label={t('admin.auth.require_third_party_auth')}
            checked={requireThirdPartyAuth}
            onChange={() => setRequireThirdPartyAuth((requireThirdPartyAuth) => !requireThirdPartyAuth)}
          />
          <FormText color="muted">{t('admin.auth.require_third_party_auth_help')}</FormText>
        </FormRow>

        <FormRow>
          <CustomInput
            type="checkbox"
            id="disablePasswordAuth"
            label={t('admin.auth.disable_password_auth')}
            checked={disablePasswordAuth}
            onChange={() => setDisablePasswordAuth((disablePasswordAuth) => !disablePasswordAuth)}
          />
          <FormText color="muted">{t('admin.auth.disable_password_auth_help')}</FormText>
        </FormRow>

        <FormRow>
          <Button color="primary">{t('Update')}</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

export default AuthSettings
