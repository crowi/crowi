import React from 'react'
import Icon from '../Common/Icon'
import UserDate from '../Common/UserDate'
import UserPicture from '../User/UserPicture'
import { Notification } from 'client/types/crowi'

interface Props {
  children: React.ReactNode
  notification: Notification
  icon: string
  onClick: () => void
}

export default class NotificationContent extends React.Component<Props> {
  static defaultProps = { icon: 'checkbox-blank-circle' }

  getUserImage() {
    const actionUsers = this.props.notification.actionUsers

    if (actionUsers.length < 1) {
      // what is this case?
      return ''
    }

    return <UserPicture user={actionUsers[0]} />
  }

  render() {
    const notification = this.props.notification

    let boxClass = 'notification-box'
    if (notification.status !== 'OPENED') {
      boxClass += ' notification-unread'
    }

    return (
      <li className="notification-list-li">
        <div className={boxClass} onClick={this.props.onClick}>
          <div className="notification-box-image">{this.getUserImage()}</div>
          <div className="notification-box-message">
            <div className="notification-box-text">{this.props.children}</div>
            <div className="notification-box-time">
              <Icon name={this.props.icon} />
              <UserDate className="ml-1" dateTime={notification.createdAt} format="fromNow" />
            </div>
          </div>
        </div>
      </li>
    )
  }
}
