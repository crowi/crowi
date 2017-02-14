import React from 'react';

import Icon        from '../Common/Icon';
import UserDate    from '../Common/UserDate';
import UserPicture from '../User/UserPicture';
import PagePath    from '../PageList/PagePath';

export default class Notification extends React.Component {

  handleOnClick(e) {
    e.preventDefault();

    if (this.props.onClick) {
      this.props.onClick(this.props.notification);
    }
  }

  getActionUsers() {
    const notification = this.props.notification;
    const latestUsers = notification.latestActionUsers.map((user) => {
      return '@' + user.username;
    });

    let actionedUsers = '';
    const latestUsersCount = latestUsers.length;
    if (latestUsersCount === 1) {
      actionedUsers = latestUsers[0];
    } else if (notification.actionUsersCount >= 4) {
      actionedUsers = latestUsers.slice(0, 2).join(', ') + ` and ${notification.actionUsersCount - 2} others`;
    } else {
      actionedUsers = latestUsers.join(', ');
    }

    return actionedUsers;
  }

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
        <div className={boxClass} onClick={this.handleOnClick.bind(this)}>
          <div className="notification-box-image">
            {this.getUserImage()}
          </div>
          <div className="notification-box-message">
            <div className="notification-box-text">
              <span><b>{this.getActionUsers()}</b> commented on <PagePath page={notification.target} /></span>
            </div>
            <div className="notification-box-time">
              <Icon name="comment" /> <UserDate dateTime={notification.createdAt} format="fromNow" />
            </div>
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
