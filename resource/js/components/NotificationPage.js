// This is the root component for #notification-page

import React from 'react';
import Crowi from '../util/Crowi';
import ListView from './Notification/ListView';
import Pager from './Notification/Pager';

export default class NotificationPage extends React.Component {

  constructor(props) {
    super(props);

    this.crowi = window.crowi; // FIXME

    this.limit  = 16;
    this.offset = 0;

    this.state = {
      notifications: [],
      hasPrev: false,
      hasNext: false,
    };
  }

  componentDidMount() {
    this.getNotifications();
  }

  handleNotificationOnClick(notification) {
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
    this.crowi.apiGet('/notification.list', {
      limit: this.limit,
      offset: this.offset,
    })
      .then(res => {
        return this.setState({
          notifications: res.notifications,
          hasPrev: res.hasPrev,
          hasNext: res.hasNext,
        });
      })
      .catch(err => {
        // TODO error handling
      })
    ;
  };

  handleNextClick() {
    this.offset = this.offset + this.limit;
    this.getNotifications();
  }

  handlePrevClick() {
    this.offset = this.offset - this.limit;
    if (this.offset < 0) {
      this.offset = 0;
    }
    this.getNotifications();
  }

  render() {
    return (
      <div>
        <Pager
          hasPrev={this.state.hasPrev}
          hasNext={this.state.hasNext}
          handlePrevClick={this.handlePrevClick.bind(this)}
          handleNextClick={this.handleNextClick.bind(this)}
          />
        <ListView
          notifications={this.state.notifications}
          notificationClickHandler={this.handleNotificationOnClick.bind(this)}
          />
        <Pager
          hasPrev={this.state.hasPrev}
          hasNext={this.state.hasNext}
          handlePrevClick={this.handlePrevClick.bind(this)}
          handleNextClick={this.handleNextClick.bind(this)}
          />
      </div>
    );
  }
}

NotificationPage.propTypes = {
};
NotificationPage.defaultProps = {
};
