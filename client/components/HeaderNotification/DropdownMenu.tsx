import React from 'react'
import PropTypes from 'prop-types'
import Notification from '../Notification/Notification'
import NullNotification from '../Notification/NullNotification'
import Icon from '../Common/Icon'
import { DropdownMenu as Menu } from 'reactstrap'

export default class DropdownMenu extends React.Component {
  render() {
    let listView

    if (!this.props.loaded) {
      listView = (
        <li className="notification-loader">
          <Icon name="pulse" spin={true} />
        </li>
      )
    } else if (this.props.notifications.length <= 0) {
      listView = <NullNotification />
    } else {
      listView = this.props.notifications.map(notification => {
        return <Notification key={'notification:header:' + notification._id} notification={notification} onClickHandler={this.props.notificationClickHandler} />
      })
    }

    return (
      <Menu tag="ul" right>
        <li className="notification-arrow" />
        {listView}
        <li>
          <a href="/me/notifications" className="notification-see-all">
            See All
          </a>
        </li>
      </Menu>
    )
  }
}

DropdownMenu.propTypes = {
  loaded: PropTypes.bool.isRequired,
  notifications: PropTypes.array.isRequired,
  notificationClickHandler: PropTypes.func.isRequired,
}

DropdownMenu.defaultProps = {}
