import React from 'react';

import Icon        from '../Common/Icon';
import UserDate    from '../Common/UserDate';
import UserPicture from '../User/UserPicture';

export default class NotificationContent extends React.Component {

  getUserImage() {
    const latestActionUsers = this.props.notification.latestActionUsers;

    if (latestActionUsers.length < 1) {
      // what is this case?
      return '';
    }

    return <UserPicture user={latestActionUsers[0]} />
  }

  render() {
    const notification = this.props.notification;

    let boxClass = 'notification-box';
    if (notification.isRead === false) {
      boxClass += ' notification-unread';
    }

    return (
      <li className="notification-list-li">
        <div className={boxClass} onClick={this.props.onClick}>
          <div className="notification-box-image">
            {this.getUserImage()}
          </div>
          <div className="notification-box-message">
            <div className="notification-box-text">
              {this.props.children}
            </div>
            <div className="notification-box-time">
              <Icon name={this.props.icon} /> <UserDate dateTime={notification.createdAt} format="fromNow" />
            </div>
          </div>
        </div>
      </li>
    );
  }
}

NotificationContent.propTypes = {
  notification: React.PropTypes.object.isRequired,
  icon: React.PropTypes.string,
  onClick: React.PropTypes.func.isRequired,
};

NotificationContent.defaultProps = {
  icon: 'circle-o',
};

