import React, { FC } from 'react'
import classNames from 'classnames'
import Document from 'server/components/Document'
import Single from 'server/components/Layout/Single'
import { PageProps } from 'server/types/pageProps'
import App from 'server/components/App'
import Alert from 'server/components/Alert'
import Icon from 'client/components/Common/Icon'

const navigationItems = [
  { name: 'user', icon: 'cogs', link: '/me', text: 'User Information' },
  { name: 'password', icon: 'key', link: '/me/password', text: 'Password Settings' },
  { name: 'notifications', icon: 'bell', link: '/me/notifications', text: 'Notifications' },
  { name: 'apiToken', icon: 'rocket', link: '/me/apiToken', text: 'API Settings' },
] as const

export type Props = {
  title: string
  activeItem: typeof navigationItems[number]['name']
  messages?: {
    success?: string | string[]
    warning?: string | string[]
    error?: string | string[]
  }
} & PageProps

const Base: FC<Props> = props => {
  const { i18n, context, title, activeItem, messages, children } = props

  return (
    <Document title={`${title} · ${context.path}`} context={context}>
      <App i18n={i18n} context={context}>
        <Single>
          <div className="header-wrap">
            <header id="page-header">
              <h1 className="title">{title}</h1>
            </header>
          </div>

          <div className="content-main content-form">
            <ul className="nav nav-tabs">
              {navigationItems.map(({ name, icon, link, text }) =>
                name !== 'password' || !context.auth.disablePasswordAuth ? (
                  <li key={name} className={classNames('nav-item', activeItem === name ? 'active' : null)}>
                    <a className="nav-link" href={link}>
                      <Icon name={icon} /> {i18n.t(text)}
                    </a>
                  </li>
                ) : null,
              )}
            </ul>

            <div className="tab-content">
              <Alert type="success" messages={messages?.success} />
              <Alert type="danger" messages={messages?.warning} />
              <Alert type="danger" messages={messages?.error} />

              {children}
            </div>
          </div>
        </Single>
      </App>
    </Document>
  )
}

export default Base
