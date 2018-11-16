import React from 'react'
import PropTypes from 'prop-types'
import UserPicture from '../User/UserPicture'

import PageCommentNotification from './ModelAction/PageCommentNotification'
import PageLikeNotification from './ModelAction/PageLikeNotification'

export default class Notification extends React.Component {
  onClickHandler() {
    this.props.onClickHandler(this.props.notification)
  }

  getActionUsers() {
    const notification = this.props.notification
    const latestActionUsers = notification.actionUsers.slice(0, 3)
    const latestUsers = latestActionUsers.map(user => {
      return '@' + user.username
    })

    let actionedUsers = ''
    const latestUsersCount = latestUsers.length
    if (latestUsersCount === 1) {
      actionedUsers = latestUsers[0]
    } else if (notification.actionUsers.length >= 4) {
      actionedUsers = latestUsers.slice(0, 2).join(', ') + ` and ${notification.actionUsers.length - 2} others`
    } else {
      actionedUsers = latestUsers.join(', ')
    }

    return actionedUsers
  }

  getUserImage() {
    const latestActionUsers = this.props.notification.actionUsers.slice(0, 3)

    if (latestActionUsers.length < 1) {
      // what is this case?
      return ''
    }

    return <UserPicture user={latestActionUsers[0]} />
  }

  render() {
    let cmp = ''
    const notification = this.props.notification
    const componentName = `${notification.targetModel}:${notification.action}`
    const props = {
      actionUsers: this.getActionUsers(),
      ...this.props,
    }

    switch (componentName) {
      case 'Page:COMMENT':
        cmp = <PageCommentNotification {...props} onClick={this.onClickHandler.bind(this)} />
        break
      case 'Page:LIKE':
        cmp = <PageLikeNotification {...props} onClick={this.onClickHandler.bind(this)} />
        break
      default:
    }

    return cmp
  }
}

Notification.propTypes = {
  notification: PropTypes.object.isRequired,
  onClickHandler: PropTypes.func.isRequired,
}

Notification.defaultProps = {}
