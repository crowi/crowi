import React from 'react';

export default class Notification extends React.Component {

  handleOnClick(e) {
    e.preventDefault();

    if (this.props.onClick) {
      this.props.onClick(this.props.notification);
    }
  }

  getActionUsers() {
    const latestUsers = this.props.notification.latestActionUsers.map((user) => {
      return user.username;
    });

    let actionedUsers = '';
    if (latestUsers.length === 1) {
      actionedUsers = latestUsers[0];
    } else {
      actionedUsers = latestUsers.join(', ');
    }

    return actionedUsers;
  }

  getActionedTime() {
    return this.props.notification.createdAt.toString();
  }

  getUserImage() {
    const latestActionUsers = this.props.notification.latestActionUsers;

    if (latestActionUsers.length >= 1) {
      if (latestActionUsers[0].image) {
        return latestActionUsers[0].image;
      }
    }

    return '/images/userpicture.png'; // TODO: use const
  }

  render() {
    const notification = this.props.notification;

    let boxClass = 'notification-box';
    if (notification.isRead === false) {
      boxClass += ' notification-unread';
    }

    return (
      <li className="notification-list-li">
        <div className={boxClass} onClick={this.handleOnClick.bind(this)}>
          <div className="notification-box-image">
            <img src={this.getUserImage()} className="picture picture-rounded" />
          </div>
          <div className="notification-box-message">
            <div className="notification-box-text">
              <span><b>{this.getActionUsers()}</b> commented on <b>{notification.target.path}</b></span>
            </div>
            <div className="notification-box-time">{this.getActionedTime()}</div>
          </div>
        </div>
      </li>
    );
  }
}

Notification.propTypes = {
  notification: React.PropTypes.object.isRequired,
};

Notification.defaultProps = {
  notification: {},
};
