import React from 'react'
import PropTypes from 'prop-types'
import NotificationContent from '../NotificationContent'
import PagePath from 'components/PageList/PagePath'
export default class PageCommentNotification extends React.Component {
  render() {
    const notification = this.props.notification

    return (
      <NotificationContent {...this.props} icon="comment">
        <span>
          <b>{this.props.actionUsers}</b> commented on <PagePath page={notification.target} />
        </span>
      </NotificationContent>
    )
  }
}

PageCommentNotification.propTypes = {
  actionUsers: PropTypes.string.isRequired,
  notification: PropTypes.object.isRequired,
  onClick: PropTypes.func.isRequired,
}

PageCommentNotification.defaultProps = {}
