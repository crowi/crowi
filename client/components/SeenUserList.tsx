import React from 'react'
import UserList from './SeenUserList/UserList'
import Crowi from 'client/util/Crowi'
import { User } from 'client/types/crowi'

interface Props {
  crowi: Crowi
}

interface State {
  seenUsers: User[]
}

export default class SeenUserList extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      seenUsers: [],
    }
  }

  componentDidMount() {
    const seenUserIds = this.getSeenUserIds()

    if (seenUserIds.length > 0) {
      // FIXME: user data cache
      this.setState({ seenUsers: this.props.crowi.findUserByIds(seenUserIds) })
    }
  }

  getSeenUserIds() {
    // FIXME: Consider another way to bind values.
    const $seenUserList = $('#seen-user-list')
    if ($seenUserList.length > 0) {
      const seenUsers = $seenUserList.data('seen-users')
      if (seenUsers) {
        return seenUsers.split(',')
      }
    }

    return []
  }

  render() {
    const { seenUsers } = this.state
    return (
      <div className="seen-user-list">
        <p className="seen-user-count">{seenUsers.length}</p>
        <UserList users={seenUsers} />
      </div>
    )
  }
}
