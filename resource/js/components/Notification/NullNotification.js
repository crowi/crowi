import React from 'react';

export default class NullNotification extends React.Component {
  render() {
    return (
      <li className="notification-list-li">
        <div className="notification-box">You had no notificatoins, yet.</div>
      </li>
    );
  }
}

NullNotification.propTypes = {
};

NullNotification.defaultProps = {
};
