import React, { useContext, useState, useEffect } from 'react'

import { AdminContext } from 'components/Admin/AdminPage'
import NotificationSettings from './NotificationSettings'
import NotificationPatterns from './NotificationPatterns'
import Instructions from './Instructions'
import ConnectButton from './ConnectButton'

function useFetchNotificationSettings(crowi) {
  const [settings, setSettings] = useState({ settings: {}, slackSetting: {}, hasSlackConfig: null, hasSlackToken: null, slackAuthUrl: null })

  const fetchSettings = async () => {
    const { settings, slackSetting, hasSlackConfig, hasSlackToken, slackAuthUrl } = await crowi.apiGet('/admin/notification')
    setSettings({ settings, slackSetting, hasSlackConfig, hasSlackToken, slackAuthUrl })
  }

  return [settings, fetchSettings]
}

export default function NotificationPage() {
  const { crowi, loading } = useContext(AdminContext)
  const [{ settings, slackSetting, hasSlackConfig, hasSlackToken, slackAuthUrl }, fetchSettings] = useFetchNotificationSettings(crowi)

  const addPattern = async ({ pathPattern, channel }) => {
    await crowi.apiPost('/admin/notification.add', { pathPattern, channel })
    await fetchSettings()
  }

  const removePattern = async id => {
    await crowi.apiPost('/admin/notification.remove', { id })
    await fetchSettings()
  }

  useEffect(() => {
    fetchSettings()
  }, [])

  return (
    !loading && (
      <>
        <NotificationSettings slackSetting={slackSetting} fetchSettings={fetchSettings} />
        {slackAuthUrl && <ConnectButton hasSlackToken={hasSlackToken} slackAuthUrl={slackAuthUrl} />}
        {hasSlackConfig === true && <NotificationPatterns settings={settings} addPattern={addPattern} removePattern={removePattern} />}
        {hasSlackConfig === false && <Instructions />}
      </>
    )
  )
}
