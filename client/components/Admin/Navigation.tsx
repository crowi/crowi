import React, { useContext, useEffect, FC } from 'react'
import { NavLink } from 'react-router-dom'

import Icon from 'components/Common/Icon'
import { AdminContext } from 'components/Admin/AdminPage'

const Navigation: FC<{}> = () => {
  const { settingForm, searchConfigured } = useContext(AdminContext)

  const items = [
    { key: 'index', to: '/admin', icon: 'mdi-cube', name: 'Wiki 管理トップ', title: 'Wiki管理', exact: true },
    { key: 'app', to: '/admin/app', icon: 'mdi-cogs', name: 'アプリ設定' },
    { key: 'notification', to: '/admin/notification', icon: 'mdi-bell', name: '通知管理' },
    { key: 'user', to: '/admin/users', icon: 'mdi-account-group', name: 'ユーザー管理' },
    { key: 'search', to: '/admin/search', icon: 'mdi-magnify', name: '検索管理', show: searchConfigured },
    { key: 'share', to: '/admin/share', icon: 'mdi-open-in-new', name: '外部共有設定' },
    { key: 'backlink', to: '/admin/backlink', icon: 'mdi-anchor', name: 'バックリンク管理' },
  ]

  useEffect(() => {
    const appTitle = settingForm['app:title'] || 'Crowi'
    const { title = undefined, name = '' } = items.find(({ to }) => to === location.pathname) || {}
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
              <Icon name={icon} /> {name}
            </NavLink>
          ),
      )}
    </div>
  )
}

export default Navigation
