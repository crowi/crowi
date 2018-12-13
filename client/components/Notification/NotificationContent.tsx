import React from 'react'
import PropTypes from 'prop-types'
import Icon from '../Common/Icon'
import UserDate from '../Common/UserDate'
import UserPicture from '../User/UserPicture'

export default class NotificationContent extends React.Component {
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
              <Icon name={this.props.icon} regular />
              <UserDate className="ml-1" dateTime={notification.createdAt} format="fromNow" />
            </div>
          </div>
        </div>
      </li>
    )
  }
}

NotificationContent.propTypes = {
  children: PropTypes.node.isRequired,
  notification: PropTypes.object.isRequired,
  icon: PropTypes.string,
  onClick: PropTypes.func.isRequired,
}

NotificationContent.defaultProps = {
  icon: 'circle-o',
}
