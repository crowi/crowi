import React from 'react';

export default class Notification extends React.Component {

  handleOnClick(e) {
    e.preventDefault();

    if (this.props.onClick) {
      this.props.onClick(this.props.notification);
    }
  }

  getActionUsers() {
    const latest_users = this.props.notification.latest_action_users.map((user) => {
      return user.username;
    });

    let actioned_users = '';
    if (latest_users.length === 1) {
      actioned_users = latest_users[0];
    } else {
      actioned_users = latest_users.join(', ');
    }

    return actioned_users;
  }

  getActionedTime() {
    return this.props.notification.createdAt.toString();
  }

  getUserImage() {
    const latest_action_users = this.props.notification.latest_action_users;

    if (latest_action_users.length >= 1) {
      if (latest_action_users[0].image) {
        return latest_action_users[0].image;
      }
    }

    return '/images/userpicture.png'; // TODO: use const
  }

  render() {
    const notification = this.props.notification;
    console.log(notification);

    let boxClass = 'notification-box';
    if (notification.is_read === false) {
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
