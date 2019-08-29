import React from 'react'
import Icon from 'components/Common/Icon'
import { User } from 'client/types/crowi'

interface Props {
  data: {
    user?: User
  }
}

export default class PageAlert extends React.Component<Props> {
  render() {
    const user = this.props.data.user

    if (!user) {
      return null
    }

    const message = <span>{user.name} edited this page.</span>

    // TODO: PageAlert.Message etc.
    return (
      <div className="fk-notif fk-notif-danger">
        <Icon name="alert" /> {message}{' '}
        <a href="javascript:location.reload();">
          <Icon name="chevronDoubleRight" /> Load latest
        </a>
      </div>
    )
  }
}
