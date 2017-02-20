import React from 'react';

import NotificationContent from '../NotificationContent';
import PagePath            from '../../PageList/PagePath';

export default class PageLikeNotification extends React.Component {

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

  render() {
    const notification = this.props.notification;

    return (
      <NotificationContent {...this.props} icon="thumbs-o-up">
        <span><b>{this.getActionUsers()}</b> liked <PagePath page={notification.target} /></span>
      </NotificationContent>
    );
  }
}

PageLikeNotification.propTypes = {
  notification: React.PropTypes.object.isRequired,
  onClick: React.PropTypes.func.isRequired,
};

PageLikeNotification.defaultProps = {
};


