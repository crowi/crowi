import React, { createContext, useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { BrowserRouter as Router, Switch, Route } from 'react-router-dom'

import Top from './TopPage'
import App from './App/AppPage'
import Notification from './Notification/NotificationPage'
import User from './User/UserPage'
import Search from './Search/SearchPage'
import Share from './Share/SharePage'
import Backlink from './Backlink/BacklinkPage'
import Navigation from './Navigation'

export const AdminContext = createContext()

function useSearchConfig(crowi) {
  const [searchConfigured, setSearchConfigured] = useState(false)

  const fetchSearchConfig = async () => {
    const { searchConfigured: isConfigured = false } = await crowi.apiGet('/admin')
    setSearchConfigured(isConfigured)
  }

  return [searchConfigured, fetchSearchConfig]
}

function useFetchSettings(crowi) {
  const [settings, setSettings] = useState({ settingForm: {}, registrationMode: {}, isUploadable: false })

  const fetchSettings = async () => {
    const { settingForm, registrationMode, isUploadable } = await crowi.apiGet('/admin/app')
    setSettings({ settingForm, registrationMode, isUploadable })
  }

  return [settings, fetchSettings]
}

function AdminPage({ crowi }) {
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

AdminPage.propTypes = {
  crowi: PropTypes.object.isRequired,
}

export default AdminPage
