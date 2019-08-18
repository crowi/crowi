import React from 'react'
import NotificationItem from '../NotificationItem'
import PagePath from 'components/PageList/PagePath'
import { Notification } from 'client/types/crowi'

interface Props {
  actionUsers: string
  notification: Notification
  onClick: () => void
}
export default class PageCommentNotification extends React.Component<Props> {
  render() {
    const notification = this.props.notification

    return (
      <NotificationItem {...this.props} icon="comment">
        <span>
          <b>{this.props.actionUsers}</b> commented on <PagePath page={notification.target} />
        </span>
      </NotificationItem>
    )
  }
}
