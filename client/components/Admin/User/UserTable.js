import React from 'react'
import Pagination from 'components/Common/Pagination'
import UserSearchForm from './UserSearchForm'
import UserTableRow from './UserTableRow'

export const STATUS = {
  REGISTERED: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  DELETED: 4,
  INVITED: 5,
}

function withPreventDefault(callback) {
  return e => {
    e.preventDefault()
    callback(e)
  }
}

function getHanlders(openResetModal, changeStatus) {
  return {
    handleClickEdit() {
      // TODO: Implement
    },
    handleClickResetPassword(user) {
      openResetModal({ user })
    },
    handleClickApprove(user) {
      changeStatus(user, 'activate')
    },
    handleClickSuspend(user) {
      changeStatus(user, 'suspend')
    },
    handleClickRestore(user) {
      changeStatus(user, 'activate')
    },
    handleClickRemove(user) {
      changeStatus(user, 'remove')
    },
    handleClickRemoveCompletely(user) {
      changeStatus(user, 'removeCompletely')
    },
    handleClickRevokeAdmin(user) {
      changeStatus(user, 'removeFromAdmin')
    },
    handleClickGrantAdmin(user) {
      changeStatus(user, 'makeAdmin')
    },
  }
}

export default function UserTable({ me, users, pagination, query, setQuery, search, move, openResetModal, changeStatus }) {
  const { current, count } = pagination
  const handlers = getHanlders(openResetModal, changeStatus)
  return (
    <>
      <UserSearchForm value={query} handleChange={e => setQuery(e.target.value)} handleSubmit={withPreventDefault(() => search(query))} />
      {users !== null ? (
        users.length ? (
          <>
            <table className="table table-hover table-striped table-bordered">
              <thead>
                <tr>
                  <th>#</th>
                  <th>ユーザーID</th>
                  <th>名前</th>
                  <th>メールアドレス</th>
                  <th>作成日</th>
                  <th>ステータス</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>{users.map(user => <UserTableRow key={user._id} changeStatus={changeStatus} me={me} user={user} {...handlers} />)}</tbody>
            </table>
            <Pagination current={current} count={count} onClick={move} />
          </>
        ) : (
          <p>ユーザーが見つかりませんでした</p>
        )
      ) : null}
    </>
  )
}
