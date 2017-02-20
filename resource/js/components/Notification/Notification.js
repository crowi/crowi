import React from 'react';

import Icon        from '../Common/Icon';
import UserDate    from '../Common/UserDate';
import UserPicture from '../User/UserPicture';
import PagePath    from '../PageList/PagePath';

import PageCommentNotification from './ModelAction/PageCommentNotification';
import PageLikeNotification    from './ModelAction/PageLikeNotification';

export default class Notification extends React.Component {

  onClickHandler() {
    this.props.onClickHandler(this.props.notification);
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
    let cmp = '';
    const notification = this.props.notification;
    const componentName = `${notification.targetModel}:${notification.action}`;

    switch (componentName) {
      case 'Page:COMMENT':
        cmp = <PageCommentNotification {...this.props} onClick={this.onClickHandler.bind(this)} />
        break;
      case 'Page:LIKE':
        cmp = <PageLikeNotification {...this.props} onClick={this.onClickHandler.bind(this)} />
        break;
      default:
    }

    return cmp;
  }
}

Notification.propTypes = {
  notification: React.PropTypes.object.isRequired,
  onClickHandler: React.PropTypes.func.isRequired,
};

Notification.defaultProps = {
};
