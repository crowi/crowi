import React from 'react'
import PropTypes from 'prop-types'
import Icon from 'components/Common/Icon'
import NotificationContent from '../NotificationContent'
import PagePath from 'components/PageList/PagePath'

export default class PageMentionotification extends React.Component {
  render() {
    const notification = this.props.notification

    return (
      <NotificationContent {...this.props} icon={<Icon name="at" solid />}>
        <span>
          <b>{this.props.actionUsers}</b> mentioned <PagePath page={notification.target} />
        </span>
      </NotificationContent>
    )
  }
}

PageMentionotification.propTypes = {
  actionUsers: PropTypes.string.isRequired,
  notification: PropTypes.object.isRequired,
  onClick: PropTypes.func.isRequired,
}

PageMentionotification.defaultProps = {}
