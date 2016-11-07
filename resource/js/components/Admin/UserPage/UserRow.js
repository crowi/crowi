import React from 'react';

import moment from 'moment';

import UserPicture from '../../User/UserPicture';
import AdminUserPageUserOperations from './UserOperations';

export default class AdminUserPageUserRow extends React.Component {
  render() {
    const user = this.props.user;
    const createdAt = moment(user.createdAt).format('YYYY-MM-DD')

    return (
      <tr>
        <td>
          <UserPicture user={user} />
        </td>
        <td>
          <strong>{user.username}</strong>
        </td>
        <td>{user.name}</td>
        <td>{user.email}</td>
        <td>{createdAt}</td>
        <td><AdminUserPageUserOperations user={user} /></td>
      </tr>
    );
  }
}


