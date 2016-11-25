import React from 'react';
import axios from 'axios';
import DropdownMenu from './HeaderNotification/DropdownMenu';
import io from 'socket.io-client';

export default class HeaderNotification extends React.Component {
  constructor(props) {
    super(props);

    this.crowi = window.crowi; // FIXME

    this.state = {
      count: '',
      notifications: [],
      is_read: true,
    };
  }

  componentDidMount() {
    this.initializeSocket();
    this.fetchList();
    this.fetchStatus();
  }

  initializeSocket() {
    const socket = io();
    socket.on('notification updated', (data) => {
      if (this.props.me === data.status.user) {
        this.fetchList();
        this.fetchStatus();
      }
    });
  }

  fetchStatus() {
    this.crowi.apiGet('/notification.status')
      .then(res => {
        if (res.status !== null) {
          if (res.status.is_read === false && res.status.count > 0) {
            this.setState({
              count: res.status.count,
              is_read: res.status.is_read,
            });
          }
        }
      })
      .catch(err => {
        // TODO: error handling
      })
    ;
  }

  updateStatus() {
    this.crowi.apiPost('/notification.status_read')
      .then(res => {
        this.setState({
          count: '',
          is_read: true,
        });
      })
      .catch(err => {
        // TODO: error handling
      });
    ;
  }

  fetchList() {
    const limit = 6;

    this.crowi.apiGet('/notification.list', {limit: limit})
      .then(res => {
        this.setState({
          notifications: res.notifications
        });
      })
      .catch(err => {
        // TODO: error handling
      })
    ;
  }

  handleOnClick(e) {
    e.preventDefault(e);
    this.updateStatus();
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

  render() {
    return (
      <div id="notif-wrapper">
        <li id="notif-opener-li" className="notif">
          <a href="#" id="notif-opener" className="dropdown-toggle" data-toggle="dropdown" onClick={this.handleOnClick.bind(this)}>
            <i className="fa fa-globe"></i> <span className="badge badge-danger">{this.state.count}</span>
          </a>
          <DropdownMenu
            notifications={this.state.notifications}
            notificationClickHandler={this.handleNotificationOnClick.bind(this)}
            />
        </li>
      </div>
    );
  }
}

HeaderNotification.propTypes = {
};

HeaderNotification.defaltProps = {
};
