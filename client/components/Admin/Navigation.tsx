import React, { useContext, useEffect, FC } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Icon from 'components/Common/Icon'
import { AdminContext } from 'components/Admin/AdminPage'

const Navigation: FC<{}> = () => {
  const [t] = useTranslation()
  const { settingForm, searchConfigured } = useContext(AdminContext)

  const items = [
    { key: 'index', to: '/admin', icon: 'cube', name: t('admin.navigation.top'), title: t('admin.navigation.title'), exact: true } as const,
    { key: 'app', to: '/admin/app', icon: 'cogs', name: t('admin.navigation.app') } as const,
    { key: 'notification', to: '/admin/notification', icon: 'bell', name: t('admin.navigation.notification') } as const,
    { key: 'user', to: '/admin/users', icon: 'accountGroup', name: t('admin.navigation.users') } as const,
    { key: 'search', to: '/admin/search', icon: 'magnify', name: t('admin.navigation.search'), show: searchConfigured } as const,
    { key: 'share', to: '/admin/share', icon: 'openInNew', name: t('admin.navigation.share') } as const,
    { key: 'backlink', to: '/admin/backlink', icon: 'anchor', name: t('admin.navigation.backlinks') } as const,
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
