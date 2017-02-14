import React from 'react';
import Notification     from './Notification';
import NullNotification from './NullNotification';
import Icon             from '../Common/Icon';

export default class ListView extends React.Component {

  handleOnClick(notification) {
    if (this.props.notificationClickHandler) {
      this.props.notificationClickHandler(notification);
    }
  }

  render() {
    let listView;

    if (!this.props.loaded) {
      listView = <Icon name="pulse" spin={true} />;
    } else if (this.props.notifications.length <= 0) {
      listView = <NullNotification />;
    } else {
      listView = this.props.notifications.map((notification) => {
        return <Notification
          key={"notification:list:" + notification._id}
          notification={notification}
          onClick={this.handleOnClick.bind(this)}
          />;
      });
    }

    return (
      <div className="notification-list">
        <ul className="notification-list-ul">
          {listView}
        </ul>
      </div>
    );
  }
};

ListView.propTypes = {
  notifications: React.PropTypes.array.isRequired,
};

ListView.defaultProps = {
  notifications: [],
};
