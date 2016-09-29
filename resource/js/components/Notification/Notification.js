import React from 'react';

export default class Notification extends React.Component {
  render() {
    const notification = this.props.notification;

    return (
      <li className="notification-list-li">
        {notification.to}
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
