import React, { useContext, useState } from 'react'

import { AdminContext } from 'components/Admin/AdminPage'
import AppSettings from './AppSettings'
import SecuritySettings from './SecuritySettings'
import MailSettings from './MailSettings'
import AWSSettings from './AWSSettings'
import GoogleSettings from './GoogleSettings'
import GitHubSettings from './GitHubSettings'

function useRequest() {
  const [requesting, setRequesting] = useState(false)
  const startRequest = () => setRequesting(true)
  const finishRequest = () => setRequesting(false)
  const executeRequest = async request => {
    try {
      startRequest()
      await request()
    } finally {
      finishRequest()
    }
  }
  return [{ requesting }, { startRequest, finishRequest, executeRequest }]
}

function useAlert() {
  const [alert, setAlert] = useState({})

  const showAlert = (action, status, message) => setAlert({ ...alert, [action]: { message, status, show: true } })
  const hideAlert = action => {
    const { message, status } = alert[action] || {}
    setAlert({ ...alert, [action]: { message, status, show: false } })
  }

  return [{ alert }, { showAlert, hideAlert }]
}

export default function AppPage() {
  const { crowi, loading, settingForm, registrationMode, isUploadable, fetchSettings } = useContext(AdminContext)
  const [{ requesting }, { executeRequest }] = useRequest()
  const [{ alert }, { showAlert, hideAlert }] = useAlert()

  const updateSettings = action => params =>
    executeRequest(async () => {
      try {
        await crowi.apiPost(`/admin/settings/${action}`, { settingForm: params })
        await fetchSettings()

        showAlert(action, 'success', 'Updated')
      } catch ({ message }) {
        showAlert(action, 'danger', message)
      } finally {
        setTimeout(() => hideAlert(action), 5000)
      }
    })

  const props = { settingForm, requesting }

  return (
    !loading && (
      <>
        <AppSettings isUploadable={isUploadable} update={updateSettings('app')} alert={alert['app']} {...props} />
        <SecuritySettings registrationMode={registrationMode} update={updateSettings('sec')} alert={alert['sec']} {...props} />
        <MailSettings update={updateSettings('mail')} alert={alert['mail']} {...props} />
        <AWSSettings isUploadable={isUploadable} update={updateSettings('aws')} alert={alert['aws']} {...props} />
        <GoogleSettings update={updateSettings('google')} alert={alert['google']} {...props} />
        <GitHubSettings update={updateSettings('github')} alert={alert['github']} {...props} />
      </>
    )
  )
}
