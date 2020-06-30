import React from 'react'
import styled from 'styled-components'
import Notification from './Notification'
import NullNotification from './NullNotification'
import Icon from '../Common/Icon'
import { Notification as NotificationType } from 'client/types/crowi'

const NotificationList = styled.ul`
  margin: 0;
  padding: 0;
`

interface Props {
  loaded: boolean
  notifications: NotificationType[]
  notificationClickHandler: Function
}

export default class ListView extends React.Component<Props> {
  render() {
    const { loaded, notifications, notificationClickHandler } = this.props

    return (
      <NotificationList>
        {!loaded ? (
          <Icon name="loading" spin />
        ) : notifications.length <= 0 ? (
          <NullNotification />
        ) : (
          notifications.map((notification) => <Notification key={notification._id} notification={notification} onClick={notificationClickHandler} />)
        )}
      </NotificationList>
    )
  }
}
