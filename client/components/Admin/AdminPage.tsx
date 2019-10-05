import React, { createContext, useState, useEffect, FC } from 'react'
import { BrowserRouter as Router, Switch, Route } from 'react-router-dom'
import Crowi from 'client/util/Crowi'
import { AppPage } from 'components/Admin/App/AppPage'
import { BacklinkPage } from 'components/Admin/Backlink/BacklinkPage'
import { Navigation } from 'components/Admin/Navigation'
import { NotificationPage } from 'components/Admin/Notification/NotificationPage'
import { SearchPage } from 'components/Admin/Search/SearchPage'
import { SharePage } from 'components/Admin/Share/SharePage'
import { TopPage } from 'components/Admin/TopPage'
import { UserPage } from 'components/Admin/User/UserPage'

interface AdminContext {
  crowi: Crowi
  loading: boolean
  searchConfigured: boolean
  settingForm: Record<string, any>
  registrationMode: string
  isUploadable: boolean
  fetchSettings: () => Promise<void>
}

export const AdminContext = createContext<AdminContext>(({
  loading: true,
  searchConfigured: false,
  settingForm: {},
  registrationMode: '',
  isUploadable: false,
} as any) as AdminContext)

function useSearchConfig(crowi: Crowi) {
  const [searchConfigured, setSearchConfigured] = useState(false)

  const fetchSearchConfig = async () => {
    const { searchConfigured: isConfigured = false } = await crowi.apiGet('/admin')
    setSearchConfigured(isConfigured)
  }

  return [searchConfigured, fetchSearchConfig] as const
}

function useFetchSettings(crowi: Crowi) {
  const [settings, setSettings] = useState({ settingForm: {}, registrationMode: '', isUploadable: false })

  const fetchSettings = async () => {
    const { settingForm, registrationMode, isUploadable } = await crowi.apiGet('/admin/app')
    setSettings({ settingForm, registrationMode, isUploadable })
  }

  return [settings, fetchSettings] as const
}

interface Props {
  crowi: Crowi
}

export const AdminPage: FC<Props> = ({ crowi }) => {
  const [loading, setLoading] = useState(true)
  const [searchConfigured, fetchSearchConfig] = useSearchConfig(crowi)
  const [settings, fetchSettings] = useFetchSettings(crowi)
  const { settingForm, registrationMode, isUploadable } = settings

  const fetchContext = async () => {
    try {
      await Promise.all([fetchSearchConfig(), fetchSettings()])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchContext()
  }, [])

  const context = { crowi, loading, searchConfigured, settingForm, registrationMode, isUploadable, fetchSettings }

  return (
    <Router>
      <AdminContext.Provider value={context}>
        <div className="row">
          <div className="col-md-3">
            <Navigation />
          </div>
          <div className="col-md-9">
            <Switch>
              <Route path="/admin" exact component={TopPage} />
              <Route path="/admin/app" component={AppPage} />
              <Route path="/admin/notification" component={NotificationPage} />
              <Route path="/admin/users" component={UserPage} />
              <Route path="/admin/search" component={SearchPage} />
              <Route path="/admin/share" component={SharePage} />
              <Route path="/admin/backlink" component={BacklinkPage} />
            </Switch>
          </div>
        </div>
      </AdminContext.Provider>
    </Router>
  )
}
