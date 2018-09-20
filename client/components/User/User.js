// @flow
import React from 'react';

import UserPicture from './UserPicture'

type Props = {
  user: Object,
  name: boolean,
  username: boolean,
};

export default class User extends React.Component {
  props: Props;
  render() {
    const user = this.props.user
    const userLink = '/user/' + user.username

    const username = this.props.username
    const name = this.props.name

    return (
      <span className="user-component">
        <a href={userLink}>
          <UserPicture user={user} />

          {username && <span className="user-component-username">@{user.username}</span>}
          {name && <span className="user-component-name">({user.name})</span>}
        </a>
      </span>
    )
  }
}

User.defaultProps = {
  name: false,
  username: false,
}
