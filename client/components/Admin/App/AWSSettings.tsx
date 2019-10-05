import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Label, Input } from 'reactstrap'
import { Tips } from 'components/Admin/App/Tips'
import { FormRow } from 'components/Admin/FormRow'

interface Props {
  settingForm: object
  update: (settings: object) => void
  alert: {
    status: string
    show: boolean
    message: string
  }
}

export const AWSSettings: FC<Props> = ({ settingForm, update, alert }) => {
  const [t] = useTranslation()
  const [region, setRegion] = useState(settingForm['aws:region'] || '')
  const [bucket, setBucket] = useState(settingForm['aws:bucket'] || '')
  const [accessKeyId, setAccessKeyId] = useState(settingForm['aws:accessKeyId'] || '')
  const [secretAccessKey, setSecretAccessKey] = useState(settingForm['aws:secretAccessKey'] || '')

  const handleSubmit = e => {
    e.preventDefault()
    update({
      'aws:region': region,
      'aws:bucket': bucket,
      'aws:accessKeyId': accessKeyId,
      'aws:secretAccessKey': secretAccessKey,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.aws.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>
          {t('admin.aws.tips1')}
          <br />
          {t('admin.aws.tips2')}
          <br />
          <span className="mt-2 text-danger">
            <i className="mdi mdi-alert" /> {t('admin.aws.notice')}
          </span>
        </Tips>

        <FormRow>
          <Label for="awsRegion">{t('admin.aws.region')}</Label>
          <Input id="awsRegion" placeholder="例: ap-northeast-1" value={region} onChange={e => setRegion(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="awsBucket">{t('admin.aws.bucket')}</Label>
          <Input id="awsBucket" placeholder="例: crowi" value={bucket} onChange={e => setBucket(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="accessKeyId">{t('admin.aws.access_key_id')}</Label>
          <Input id="accessKeyId" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="secretAccessKey">{t('admin.aws.secret_access_key')}</Label>
          <Input id="secretAccessKey" value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} />
        </FormRow>

        <FormRow>
          <Button color="primary">{t('Update')}</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}
