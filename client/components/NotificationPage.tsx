// This is the root component for #notification-page

import React from 'react'
import PropTypes from 'prop-types'
import ListView from './Notification/ListView'
import Pager from './Notification/Pager'

export default class NotificationPage extends React.Component {
  constructor(props) {
    super(props)

    this.limit = 16
    this.offset = 0

    this.state = {
      notifications: [],
      loaded: false,
      hasPrev: false,
      hasNext: false,
    }
  }

  componentDidMount() {
    this.getNotifications()
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

  async getNotifications() {
    try {
      const { notifications, hasPrev, hasNext } = await this.props.crowi.apiGet('/notification.list', {
        limit: this.limit,
        offset: this.offset,
      })
      this.setState({
        notifications,
        loaded: true,
        hasPrev,
        hasNext,
      })
    } catch (err) {
      // TODO error handling
    }
  }

  handleNextClick() {
    this.offset = this.offset + this.limit
    this.getNotifications()
  }

  handlePrevClick() {
    this.offset = this.offset - this.limit
    if (this.offset < 0) {
      this.offset = 0
    }
    this.getNotifications()
  }

  render() {
    return (
      <div>
        <Pager
          hasPrev={this.state.hasPrev}
          hasNext={this.state.hasNext}
          handlePrevClick={this.handlePrevClick.bind(this)}
          handleNextClick={this.handleNextClick.bind(this)}
        />
        <ListView loaded={this.state.loaded} notifications={this.state.notifications} notificationClickHandler={this.handleNotificationOnClick.bind(this)} />
        <Pager
          hasPrev={this.state.hasPrev}
          hasNext={this.state.hasNext}
          handlePrevClick={this.handlePrevClick.bind(this)}
          handleNextClick={this.handleNextClick.bind(this)}
        />
      </div>
    )
  }
}

NotificationPage.propTypes = {
  crowi: PropTypes.object.isRequired,
}
NotificationPage.defaultProps = {}
