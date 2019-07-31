import React from 'react'
import UserList from './SeenUserList/UserList'
import Crowi from 'client/util/Crowi'
import { User } from 'client/types/crowi'
import Icon from './Common/Icon'
import { UncontrolledTooltip } from 'reactstrap'

interface Props {
  crowi: Crowi
}

interface State {
  seenUsers: User[]
  tooltipOpen: boolean
}

export default class SeenUserList extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      seenUsers: [],
      tooltipOpen: false,
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
      <div className="seen-user-list d-flex">
        <div className="flex-shrink-1 page-count-info-title">
          <Icon name="paw" id="page-seen-user" /> <span className="seen-user-count">{seenUsers.length}</span>
        </div>
        <div className="flex-grow-1 page-count-info-value">
          <UserList users={seenUsers} />
        </div>
        <UncontrolledTooltip placement="top" target="page-seen-user">
          Users who have seen this page.
        </UncontrolledTooltip>
      </div>
    )
  }
}
