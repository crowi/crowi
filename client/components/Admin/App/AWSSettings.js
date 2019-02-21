import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Label, Input } from 'reactstrap'
import Tips from './Tips'
import FormRow from '../FormRow'

function AWSSettings({ settingForm, update, alert = {} }) {
  const [region, setRegion] = useState(settingForm['aws:region'])
  const [bucket, setBucket] = useState(settingForm['aws:bucket'])
  const [awsAccessKeyId, setAwsAccessKeyId] = useState(settingForm['aws:awsAccessKeyId'])
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState(settingForm['aws:awsSecretAccessKey'])

  const handleSubmit = e => {
    e.preventDefault()
    update({
      'aws:region': region,
      'aws:bucket': bucket,
      'aws:awsAccessKeyId': awsAccessKeyId,
      'aws:awsSecretAccessKey': awsSecretAccessKey,
    })
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>AWS設定</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <Tips>
          AWS にアクセスするための設定を行います。AWS の設定を完了させると、ファイルアップロード機能、プロフィール写真機能などが有効になります。<br />
          また、SMTP の設定が無い場合、SES を利用したメール送信が行われます。FromメールアドレスのVerify、プロダクション利用設定をする必要があります。<br />
          <span className="mt-2 text-danger">
            <i className="fa fa-exclamation-triangle" />{' '}
            この設定を途中で変更すると、これまでにアップロードしたファイル等へのアクセスができなくなりますのでご注意下さい。
          </span>
        </Tips>

        <FormRow>
          <Label for="awsRegion">リージョン</Label>
          <Input id="awsRegion" placeholder="例: ap-northeast-1" value={region} onChange={e => setRegion(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="awsBucket">バケット名</Label>
          <Input id="awsBucket" placeholder="例: crowi" value={bucket} onChange={e => setBucket(e.target.value)} />
        </FormRow>

        <FormRow>
          <Label for="awsAccessKeyId">Access Key ID</Label>
          <Input id="awsAccessKeyId" value={awsAccessKeyId} onChange={e => setAwsAccessKeyId(awsAccessKeyId)} />
        </FormRow>

        <FormRow>
          <Label for="awsSecretAccessKey">Secret Access Key</Label>
          <Input id="awsSecretAccessKey" value={awsSecretAccessKey} onChange={e => setAwsSecretAccessKey(awsSecretAccessKey)} />
        </FormRow>

        <FormRow>
          <Button color="primary">更新</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

AWSSettings.propTypes = {
  settingForm: PropTypes.object.isRequired,
  update: PropTypes.func.isRequired,
}

export default AWSSettings
