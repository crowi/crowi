// @flow
import React from 'react'

import Icon from 'components/Common/Icon'

type Props = { data?: Object }

export default class PageAlert extends React.Component<Props> {
  render() {
    const user = this.props.data.user
    const message = <span>{user.name} edited this page.</span>

    // TODO: PageAlert.Message etc.
    return (
      <div className="fk-notif fk-notif-danger">
        <Icon name="exclamation-triangle" /> {message}{' '}
        <a href="javascript:location.reload();">
          <Icon name="angle-double-right" /> Load latest
        </a>
      </div>
    )
  }
}
