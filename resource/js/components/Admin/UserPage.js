// This is the root component for #admin-user-page

import React from 'react';
import Crowi from '../../util/Crowi';

import AdminUserPageUserSearchBox from './UserPage/UserSearchBox';
import AdminUserPageUserList from './UserPage/UserList';
import AdminUserPageUserCreateDialog from './UserPage/UserCreateDialog';

export default class AdminUserPage extends React.Component {
  constructor(props) {
    super(props);
    this.crowi = window.crowi; // FIXME

    this.state = {
      users: this.crowi.users,
    };
  }

  searchUser(key) {
    // search key is, user id or email
  }

  render() {
    return (
      <div>
        <AdminUserPageUserCreateDialog
        />
        <AdminUserPageUserSearchBox
        />
        <AdminUserPageUserList
          users={this.state.users}
        />
      </div>
    );
  }
}

