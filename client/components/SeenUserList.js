// @flow
import React from 'react';
import UserList from './SeenUserList/UserList'

type Props = { crowi: Object };

export default class SeenUserList extends React.Component {
  constructor(props: Props) {
    super(props)

    this.state = {
      seenUsers: [],
    }
  }

  props: Props;

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
    return (
      <div className="seen-user-list">
        <p className="seen-user-count">{this.state.seenUsers.length}</p>
        <UserList users={this.state.seenUsers} />
      </div>
    )
  }
}
