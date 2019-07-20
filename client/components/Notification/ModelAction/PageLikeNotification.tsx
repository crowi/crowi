import React from 'react'
import NotificationContent from '../NotificationContent'
import PagePath from 'components/PageList/PagePath'
import { Notification } from 'client/types/crowi'

interface Props {
  actionUsers: string
  notification: Notification
  onClick: () => void
}

export default class PageLikeNotification extends React.Component<Props> {
  render() {
    const notification = this.props.notification

    return (
      <NotificationContent {...this.props} icon="thumb-up">
        <span>
          <b>{this.props.actionUsers}</b> liked <PagePath page={notification.target} />
        </span>
      </NotificationContent>
    )
  }
}
