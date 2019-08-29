import React from 'react'
import styled from 'styled-components'
import Icon, { IconName } from '../Common/Icon'
import UserDate from '../Common/UserDate'
import UserPicture from '../User/UserPicture'
import { Notification } from 'client/types/crowi'

const NotificationImage = styled.div`
  img {
    margin-right: 16px;
  }
`

const NotificationTime = styled.div`
  padding-top: 0.3em;
  font-size: small;
`

interface Props {
  children: React.ReactNode
  notification: Notification
  icon: IconName
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

    return (
      <>
        <NotificationImage>{this.getUserImage()}</NotificationImage>
        <div>
          <div>{this.props.children}</div>
          <NotificationTime>
            <Icon name={this.props.icon} />
            <UserDate className="ml-1" dateTime={notification.createdAt} format="fromNow" />
          </NotificationTime>
        </div>
      </>
    )
  }
}
