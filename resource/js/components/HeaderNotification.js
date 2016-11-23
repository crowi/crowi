import React from 'react';
import axios from 'axios';
import DropdownMenu from './HeaderNotification/DropdownMenu';

export default class HeaderNotification extends React.Component {
  constructor(props) {
    super(props);

    this.crowi = window.crowi; // FIXME

    this.state = {
      count: '123',
      notifications: []
    };
  }

  componentDidMount() {
    this.fetch();
  }

  fetch() {
    this.crowi.apiGet('/notification.list')
      .then(res => {
        this.setState({
          count: 456,
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
    console.log('click click');
    this.setState({
      count: '',
    });
  }

  handleNotificationOnClick(notification) {
    console.log('hey!!!', notification);

    this.crowi.apiPost('/notification.read', {id: notification._id})
      .then(res => {
        // jump to target page
        window.location.href = notification.target.path;
      })
      .catch(err => {
        console.log(err);
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
