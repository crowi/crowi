import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Label, Input, CustomInput, FormText } from 'reactstrap'
import FormRow from '../FormRow'

function AppSettings({ isUploadable, settingForm, update, alert = {} }) {
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
        <legend>アプリ設定</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormRow>
          <Label for="appTitle">Wikiの名前</Label>
          <Input id="appTitle" value={title} onChange={e => setTitle(e.target.value)} />
          <FormText color="muted">ヘッダーやHTMLタイトルに使用されるWikiの名前を変更できます。</FormText>
        </FormRow>

        <FormRow>
          <Label for="appConfidential">コンフィデンシャル表示</Label>
          <Input id="appConfidential" value={confidential} onChange={e => setConfidential(e.target.value)} placeholder="例: 社外秘" />
          <FormText color="muted">ここに入力した内容は、ヘッダー等に表示されます。</FormText>
        </FormRow>

        <FormRow>
          <CustomInput
            type="checkbox"
            id="appFileUpload"
            label="画像以外のファイルアップロードを許可"
            checked={fileUpload}
            disabled={isUploadable}
            onChange={() => setFileUpload(!fileUpload)}
          />
          <FormText color="muted">
            ファイルアップロードの設定を有効にしている場合にのみ、選択可能です。<br />
            許可をしている場合、画像以外のファイルをページに添付可能になります。
          </FormText>
        </FormRow>

        <FormRow>
          <Button color="primary">更新</Button>
        </FormRow>
      </fieldset>
    </form>
  )
}

AppSettings.propTypes = {
  settingForm: PropTypes.object.isRequired,
  update: PropTypes.func.isRequired,
}

export default AppSettings
