import React from 'react'
import PropTypes from 'prop-types'
import DropdownMenu from './HeaderNotification/DropdownMenu'
import Icon from './Common/Icon'

export default class HeaderNotification extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      count: 0,
      loaded: false,
      notifications: [],
      isOpened: true,
    }
  }

  componentDidMount() {
    this.initializeSocket()
    this.fetchList()
    this.fetchStatus()
  }

  initializeSocket() {
    this.props.crowi.getWebSocket().on('notification updated', data => {
      if (this.props.me === data.user) {
        this.fetchList()
        this.fetchStatus()
      }
    })
  }

  async fetchStatus() {
    try {
      const { count = null } = await this.props.crowi.apiGet('/notification.status')
      if (count !== null && count !== this.state.count) {
        this.setState({ count })
      }
    } catch (err) {
      // TODO: error handling
    }
  }

  async updateStatus() {
    try {
      await this.props.crowi.apiPost('/notification.read')
      this.setState({ count: 0 })
    } catch (err) {
      // TODO: error handling
    }
  }

  async fetchList() {
    const limit = 6
    try {
      const { notifications } = await this.props.crowi.apiGet('/notification.list', { limit })
      this.setState({ loaded: true, notifications })
    } catch (err) {
      // TODO: error handling
    }
  }

  handleOnClick(e) {
    e.preventDefault(e)
    this.updateStatus()
  }

  async handleNotificationOnClick(notification) {
    try {
      await this.props.crowi.apiPost('/notification.open', { id: notification._id })
      // jump to target page
      window.location.href = notification.target.path
    } catch (err) {
      // TODO: error handling
    }
  }

  render() {
    let badge = ''
    if (this.state.count > 0) {
      badge = <span className="badge badge-pill badge-danger notification-badge">{this.state.count}</span>
    }

    return (
      <div className="notification-wrapper">
        <a href="#" id="notif-opener" className="nav-link dropdown-toggle" data-toggle="dropdown" onClick={this.handleOnClick.bind(this)}>
          <Icon name="bell" /> {badge}
        </a>
        <DropdownMenu
          loaded={this.state.loaded}
          notifications={this.state.notifications}
          notificationClickHandler={this.handleNotificationOnClick.bind(this)}
        />
      </div>
    )
  }
}

HeaderNotification.propTypes = {
  crowi: PropTypes.object.isRequired,
  me: PropTypes.string.isRequired,
}

HeaderNotification.defaltProps = {}
