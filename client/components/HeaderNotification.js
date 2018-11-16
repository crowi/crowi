import React from 'react'
import PropTypes from 'prop-types'
import { Dropdown, DropdownToggle } from 'reactstrap'
import DropdownMenu from './HeaderNotification/DropdownMenu'
import Icon from './Common/Icon'

export default class HeaderNotification extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      count: 0,
      loaded: false,
      notifications: [],
      open: false,
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

  toggle() {
    const { open, count } = this.state
    if (!open && count > 0) {
      this.updateStatus()
    }
    this.setState({ open: !open })
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
    const { count, open, loaded, notifications } = this.state

    let badge = ''
    if (count > 0) {
      badge = <span className="badge badge-pill badge-danger notification-badge">{count}</span>
    }

    return (
      <Dropdown className="notification-wrapper" isOpen={open} toggle={this.toggle.bind(this)}>
        <DropdownToggle tag="a" className="nav-link">
          <Icon name="bell" /> {badge}
        </DropdownToggle>
        <DropdownMenu loaded={loaded} notifications={notifications} notificationClickHandler={this.handleNotificationOnClick.bind(this)} />
      </Dropdown>
    )
  }
}

HeaderNotification.propTypes = {
  crowi: PropTypes.object.isRequired,
  me: PropTypes.string.isRequired,
}

HeaderNotification.defaltProps = {}
