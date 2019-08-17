import React from 'react'
import Notification from '../Notification/Notification'
import NullNotification from '../Notification/NullNotification'
import Icon from '../Common/Icon'
import { DropdownMenu as Menu } from 'reactstrap'
import { Notification as NotificationType } from 'client/types/crowi'

interface Props {
  loaded: boolean
  notifications: NotificationType[]
  notificationClickHandler: Function
}

export default class DropdownMenu extends React.Component<Props> {
  render() {
    let listView

    if (!this.props.loaded) {
      listView = (
        <li className="notification-loader">
          <Icon name="pulse" spin={true} />
        </li>
      )
    } else if (this.props.notifications.length <= 0) {
      listView = <NullNotification />
    } else {
      listView = this.props.notifications.map(notification => {
        return <Notification key={'notification:header:' + notification._id} notification={notification} onClickHandler={this.props.notificationClickHandler} />
      })
    }

    return (
      <Menu right>
        <ul className="notification-list-ul">{listView}</ul>
        <div className="dropdown-divider"></div>
        <a href="/me/notifications" className="notification-see-all">
          See All
        </a>
      </Menu>
    )
  }
}
