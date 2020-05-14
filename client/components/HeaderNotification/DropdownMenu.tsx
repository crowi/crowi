import React from 'react'
import styled from 'styled-components'
import Notification from '../Notification/Notification'
import NullNotification from '../Notification/NullNotification'
import Icon from '../Common/Icon'
import { DropdownMenu as Menu, DropdownItem } from 'reactstrap'
import { Notification as NotificationType } from 'client/types/crowi'

const StyledDropdownMenu = styled(Menu)`
  width: 400px;
  font-size: small;
`

const Loader = styled.li`
  padding: 8px 0;
  text-align: center;
`

const NotificationList = styled.ul`
  margin: 0;
  padding: 0;
`

const SeeAll = styled.a`
  display: block;
  text-align: center;
`

interface Props {
  loaded: boolean
  notifications: NotificationType[]
  notificationClickHandler: Function
}

export default class DropdownMenu extends React.Component<Props> {
  render() {
    const { loaded, notifications, notificationClickHandler } = this.props

    return (
      <StyledDropdownMenu right>
        <NotificationList>
          {!loaded ? (
            <Loader>
              <Icon name="loading" spin />
            </Loader>
          ) : notifications.length <= 0 ? (
            <NullNotification />
          ) : (
            notifications.map((notification) => <Notification key={notification._id} notification={notification} onClick={notificationClickHandler} />)
          )}
        </NotificationList>
        <DropdownItem divider />
        <SeeAll href="/me/notifications">See All</SeeAll>
      </StyledDropdownMenu>
    )
  }
}
