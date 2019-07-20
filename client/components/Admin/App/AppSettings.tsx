import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Label, Input, CustomInput, FormText } from 'reactstrap'
import FormRow from '../FormRow'

interface Props {
  isUploadable: boolean
  settingForm: object
  update: (settings: object) => void
  alert: {
    status: string
    show: boolean
    message: string
  }
}

const AppSettings: FC<Props> = ({ isUploadable, settingForm, update, alert }) => {
  const [t] = useTranslation()
  const [title, setTitle] = useState(settingForm['app:title'])
  const [confidential, setConfidential] = useState(settingForm['app:confidential'])
  const [fileUpload, setFileUpload] = useState(settingForm['app:fileUpload'])

  const handleSubmit = e => {
    e.preventDefault()
    update({
      'app:title': title,
      'app:confidential': confidential,
      'app:fileUpload': String(fileUpload),
    })
  }

  return (
    <form className="form-horizontal" id="appSettingForm" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.app.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormRow>
          <Label for="appTitle">{t('admin.app.title')}</Label>
          <Input id="appTitle" value={title} onChange={e => setTitle(e.target.value)} />
          <FormText color="muted">{t('admin.app.title_description')}</FormText>
        </FormRow>

        <FormRow>
          <Label for="appConfidential">{t('admin.app.confidential')}</Label>
          <Input
            id="appConfidential"
            value={confidential}
            onChange={e => setConfidential(e.target.value)}
            placeholder={t('admin.app.confidential_placeholder')}
          />
          <FormText color="muted">{t('admin.app.confidential_description')}</FormText>
        </FormRow>

        <FormRow>
          <CustomInput
            type="checkbox"
            id="appFileUpload"
            label={t('admin.app.allow_upload_file')}
            checked={fileUpload}
            disabled={!isUploadable}
            onChange={() => setFileUpload(!fileUpload)}
          />
          <FormText color="muted">
            {t('admin.app.allow_upload_file_description1')}
            <br />
            {t('admin.app.allow_upload_file_description2')}
          </FormText>
        </FormRow>

        <FormRow>
          <Button color="primary">{t('Update')}</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

export default AppSettings
