// This is the root component for #notification-page

import React from 'react';
import Crowi from '../util/Crowi';

export default class NotificationPage extends React.Component {

  constructor(props) {
    super(props);

    this.crowi = window.crowi; // FIXME

    this.state = {
    };
  }

  componentDidMount() {
  }

  getNotifications() {
    this.crowi.apiGet('/notification.list', {})
    .then(res => {
      this.setState({
        notifications: res
      });
    }).catch(err => {
      // TODO error
      this.setState({
      });
    });
  };

  render() {
    return (
      <div>
        <ListView notifications={this.state.notifications}/>
      </div>
    );
  }
}

NotificationPage.propTypes = {
};
NotificationPage.defaultProps = {
};
