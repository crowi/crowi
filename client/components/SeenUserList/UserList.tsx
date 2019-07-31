import React from 'react'
import UserPicture from 'components/User/UserPicture'
import { User } from 'client/types/crowi'

interface Props {
  users: User[]
}

export default class UserList extends React.Component<Props> {
  static defaultProps = {
    users: [],
  }

  isSeenUserListShown() {
    const userCount = this.props.users.length
    if (userCount > 0) {
      return true
    }

    return false
  }

  render() {
    if (!this.isSeenUserListShown()) {
      return null
    }

    const users = this.props.users.slice(0, 14).map(user => {
      return (
        <a key={user._id} data-user-id={user._id} href={'/user/' + user.username} title={user.name}>
          <UserPicture user={user} size="xs" />
        </a>
      )
    })

    return (
      <div className="seen-user-list d-flex">
        <div className="value w-100">{users}</div>
        {this.props.users.length > 14 && <div className="more flex-shrink-1">...</div>}
      </div>
    )
  }
}
