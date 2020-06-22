import React, { FC } from 'react'
import { PageProps } from 'server/types/pageProps'
import Base, { Props as BaseProps } from 'server/pages/Me/Base'

type Props = {
  activeItem: BaseProps['activeItem']
  messages: BaseProps['messages']
} & PageProps

const NotificationsPage: FC<Props> = props => {
  const { i18n } = props

  return (
    <Base title={i18n.t('Notifications')} {...props}>
      <div id="notification-page"></div>
    </Base>
  )
}

export default NotificationsPage
