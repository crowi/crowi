import React from 'react';
import Notification from './Notification';

export default class ListView extends React.Component {

  handleOnClick(notification) {
    if (this.props.notificationClickHandler) {
      this.props.notificationClickHandler(notification);
    }
  }

  render() {
    let listView = this.props.notifications.map((notification) => {
      return <Notification notification={notification} onClick={this.handleOnClick.bind(this)}/>;
    });

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
