import React from 'react';
import Notification from '../Notification/Notification';

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
    let listView = this.props.notifications.map((notification) => {
      return (
        <Notification
          notification={notification}
          onClick={this.handleOnClick.bind(this)}
          />
      );
    });

    return (
      <ul className="dropdown-menu">
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
