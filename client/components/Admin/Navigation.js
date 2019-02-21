import React, { useContext, useEffect } from 'react'
import { NavLink } from 'react-router-dom'

import { AdminContext } from 'components/Admin/AdminPage'

export default function Navigation() {
  const { settingForm, searchConfigured } = useContext(AdminContext)

  const items = [
    { key: 'index', to: '/admin', icon: 'fa-cube', name: 'Wiki 管理トップ', title: 'Wiki管理', exact: true },
    { key: 'app', to: '/admin/app', icon: 'fa-cogs', name: 'アプリ設定' },
    { key: 'notification', to: '/admin/notification', icon: 'fa-bell', name: '通知管理' },
    { key: 'user', to: '/admin/users', icon: 'fa-users', name: 'ユーザー管理' },
    { key: 'search', to: '/admin/search', icon: 'fa-search', name: '検索管理', show: searchConfigured },
    { key: 'share', to: '/admin/share', icon: 'fa-lock', name: '外部共有設定' },
    { key: 'backlink', to: '/admin/backlink', icon: 'fa-anchor', name: 'バックリンク管理' },
  ]

  useEffect(() => {
    const appTitle = settingForm['app:title'] || 'Crowi'
    const { title, name = '' } = items.find(({ to }) => to === location.pathname) || {}
    const pageTitle = `${title || name} · ${appTitle}`

    if (name && document.title !== pageTitle) {
      document.title = pageTitle
    }
  })

  return (
    <div className="nav nav-pills flex-column">
      {items.map(
        ({ key, to, icon, name, exact = false, show = true }) =>
          show && (
            <NavLink key={key} className="nav-link" to={to} exact={exact} activeClassName="active">
              <i className={`fa ${icon}`} /> {name}
            </NavLink>
          ),
      )}
    </div>
  )
}
