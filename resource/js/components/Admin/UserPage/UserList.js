import React from 'react';

import AdminUserPageUserRow from './UserRow';

export default class AdminUserPageUserList extends React.Component {
  render() {
    const userList = this.props.users.map((user) => {
        return (
          <AdminUserPageUserRow key={user._id} user={user} />
        );
    });

    return (
      <table className="table table-hover table-striped table-bordered">
        <thead>
          <tr>
            <th>#</th>
            <th>ユーザーID</th>
            <th>名前</th>
            <th>メールアドレス</th>
            <th>作成日</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {userList}
        </tbody>
      </table>
    );
  }
}


