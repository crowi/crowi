// This is the root component for #notification-page

import React from 'react';
import Crowi from '../util/Crowi';
import ListView from './Notification/ListView';

export default class NotificationPage extends React.Component {

  constructor(props) {
    super(props);

    this.crowi = window.crowi; // FIXME

    this.state = {
      notifications: [],
    };
  }

  componentDidMount() {
    this.getNotifications();
  }

  handleNotificationOnClick(notification) {
    console.log('Notification page', notification);

    this.crowi.apiPost('/notification.read', {id: notification._id})
      .then(res => {
        // jump to target page
        window.location.href = notification.target.path;
      })
      .catch(err => {
        // TODO: error handling
      })
    ;
  }

  getNotifications() {
    this.crowi.apiGet('/notification.list', {})
      .then(res => {
        return this.setState({
          notifications: res.notifications,
        });
      })
      .catch(err => {
        // TODO error handling
      })
    ;
  };

  render() {
    return (
      <div>
        <ListView
          notifications={this.state.notifications}
          notificationClickHandler={this.handleNotificationOnClick.bind(this)}
          />
      </div>
    );
  }
}

NotificationPage.propTypes = {
};
NotificationPage.defaultProps = {
};
