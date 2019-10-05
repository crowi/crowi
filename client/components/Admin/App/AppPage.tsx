import React, { useContext, useState } from 'react'
import { AdminContext } from 'components/Admin/AdminPage'
import { AppSettings } from 'components/Admin/App/AppSettings'
import { AWSSettings } from 'components/Admin/App/AWSSettings'
import { GitHubSettings } from 'components/Admin/App/GitHubSettings'
import { GoogleSettings } from 'components/Admin/App/GoogleSettings'
import { MailSettings } from 'components/Admin/App/MailSettings'
import { SecuritySettings } from 'components/Admin/App/SecuritySettings'

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
  return [{ requesting }, { startRequest, finishRequest, executeRequest }] as const
}

function useAlert() {
  const [alert, setAlert] = useState({})

  const showAlert = (action, status, message) => setAlert({ ...alert, [action]: { message, status, show: true } })
  const hideAlert = action => {
    const { message, status } = alert[action] || { message: '', status: '' }
    setAlert({ ...alert, [action]: { message, status, show: false } })
  }

  return [{ alert }, { showAlert, hideAlert }] as const
}

export function AppPage() {
  const { crowi, loading, settingForm, registrationMode, isUploadable, fetchSettings } = useContext(AdminContext)
  const [{ requesting }, { executeRequest }] = useRequest()
  const [{ alert }, { showAlert, hideAlert }] = useAlert()
  const defaultAlert = { status: '', show: false, message: '' }

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

  const getProps = action => ({ update: updateSettings(action), alert: alert[action] || defaultAlert, settingForm, requesting })

  return (
    !loading && (
      <>
        <AppSettings isUploadable={isUploadable} {...getProps('app')} />
        <SecuritySettings registrationMode={registrationMode} {...getProps('sec')} />
        <MailSettings {...getProps('mail')} />
        <AWSSettings {...getProps('aws')} />
        <GoogleSettings {...getProps('google')} />
        <GitHubSettings {...getProps('github')} />
      </>
    )
  )
}
