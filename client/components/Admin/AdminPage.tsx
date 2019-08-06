import React, { createContext, useState, useEffect, FC } from 'react'
import { BrowserRouter as Router, Switch, Route } from 'react-router-dom'
import Crowi from 'client/util/Crowi'

import Top from './TopPage'
import App from './App/AppPage'
import Notification from './Notification/NotificationPage'
import User from './User/UserPage'
import Search from './Search/SearchPage'
import Share from './Share/SharePage'
import Backlink from './Backlink/BacklinkPage'
import Navigation from './Navigation'

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

const AdminPage: FC<Props> = ({ crowi }) => {
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
              <Route path="/admin" exact component={Top} />
              <Route path="/admin/app" component={App} />
              <Route path="/admin/notification" component={Notification} />
              <Route path="/admin/users" component={User} />
              <Route path="/admin/search" component={Search} />
              <Route path="/admin/share" component={Share} />
              <Route path="/admin/backlink" component={Backlink} />
            </Switch>
          </div>
        </div>
      </AdminContext.Provider>
    </Router>
  )
}

export default AdminPage
