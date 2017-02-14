import React from 'react';

import Notification     from '../Notification/Notification';
import NullNotification from '../Notification/NullNotification';
import Icon             from '../Common/Icon';

export default class DropdownMenu extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
    };
  }

  handleOnClick(notification) {
    if (this.props.notificationClickHandler) {
      this.props.notificationClickHandler(notification);
    }
  }

  render() {
    let listView;

    if (!this.props.loaded) {
      listView = <li className="notification-loader"><Icon name="pulse" spin={true} /></li>;
    } else if (this.props.notifications.length <= 0) {
      listView = <NullNotification />;
    } else {
      listView = this.props.notifications.map((notification) => {
        return (
            <Notification
              key={"notification:header:" + notification._id}
              notification={notification}
              onClick={this.handleOnClick.bind(this)}
              />
        );
      });
    }

    return (
      <ul className="dropdown-menu">
        <li className="notification-arrow"></li>
        {listView}
        <li><a href="/me/notifications" className="notification-see-all">See All</a></li>
      </ul>
    );
  }
}

DropdownMenu.propTypes = {
  notifications: React.PropTypes.array.isRequired,
};

DropdownMenu.defaultProps = {
  notifications: [],
};
