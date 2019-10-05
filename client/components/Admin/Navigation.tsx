import React, { useContext, useEffect, FC } from 'react'
import { NavLink } from 'react-router-dom'

import { Icon } from 'components/Common/Icon/Icon'
import { AdminContext } from 'components/Admin/AdminPage'

export const Navigation: FC<{}> = () => {
  const { settingForm, searchConfigured } = useContext(AdminContext)

  const items = [
    { key: 'index', to: '/admin', icon: 'cube', name: 'Wiki 管理トップ', title: 'Wiki管理', exact: true } as const,
    { key: 'app', to: '/admin/app', icon: 'cogs', name: 'アプリ設定' } as const,
    { key: 'notification', to: '/admin/notification', icon: 'bell', name: '通知管理' } as const,
    { key: 'user', to: '/admin/users', icon: 'accountGroup', name: 'ユーザー管理' } as const,
    { key: 'search', to: '/admin/search', icon: 'magnify', name: '検索管理', show: searchConfigured } as const,
    { key: 'share', to: '/admin/share', icon: 'openInNew', name: '外部共有設定' } as const,
    { key: 'backlink', to: '/admin/backlink', icon: 'anchor', name: 'バックリンク管理' } as const,
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
