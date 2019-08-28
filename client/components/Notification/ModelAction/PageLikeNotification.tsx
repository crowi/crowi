import React from 'react'
import NotificationItem from '../NotificationItem'
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
      <NotificationItem {...this.props} icon="thumbUp">
        <span>
          <b>{this.props.actionUsers}</b> liked <PagePath page={notification.target} />
        </span>
      </NotificationItem>
    )
  }
}
