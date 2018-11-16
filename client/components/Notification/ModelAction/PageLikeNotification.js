import React from 'react'
import PropTypes from 'prop-types'
import NotificationContent from '../NotificationContent'
import PagePath from 'components/PageList/PagePath'

export default class PageLikeNotification extends React.Component {
  render() {
    const notification = this.props.notification

    return (
      <NotificationContent {...this.props} icon="thumbs-up">
        <span>
          <b>{this.props.actionUsers}</b> liked <PagePath page={notification.target} />
        </span>
      </NotificationContent>
    )
  }
}

PageLikeNotification.propTypes = {
  actionUsers: PropTypes.string.isRequired,
  notification: PropTypes.object.isRequired,
  onClick: PropTypes.func.isRequired,
}

PageLikeNotification.defaultProps = {}
