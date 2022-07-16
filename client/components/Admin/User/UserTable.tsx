import React, { FC } from 'react'
import { useTranslation } from 'react-i18next'

import Pagination from 'components/Common/Pagination'
import UserSearchForm from './UserSearchForm'
import UserTableRow from './UserTableRow'
import { Me } from 'client/util/Crowi'

export const STATUS = {
  REGISTERED: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  DELETED: 4,
  INVITED: 5,
}

function withPreventDefault(callback) {
  return (e) => {
    e.preventDefault()
    callback(e)
  }
}

function getHandlers(openUserEditModal, openResetModal, changeStatus) {
  return {
    handleClickEdit(user) {
      openUserEditModal({ user })
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

interface Props {
  me: Me
  users: any[]
  pagination: {
    currentPage: number
    totalPages: number
  }
  query: string
  setQuery: (query: string) => void
  search: (query: string) => void
  move: (page: number) => void
  openUserEditModal: (state: any) => void
  openResetModal: (state: any) => void
  changeStatus: (user: any, string: string) => void
}

const UserTable: FC<Props> = ({ me, users, pagination, query, setQuery, search, move, openUserEditModal, openResetModal, changeStatus }) => {
  const [t] = useTranslation()
  const { currentPage, totalPages } = pagination
  const handlers = getHandlers(openUserEditModal, openResetModal, changeStatus)
  return (
    <>
      <UserSearchForm value={query} handleChange={(e) => setQuery(e.target.value)} handleSubmit={withPreventDefault(() => search(query))} />
      {users !== null ? (
        users.length ? (
          <>
            <table className="table table-hover table-striped table-bordered">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('admin.user.user_id')}</th>
                  <th>{t('admin.user.name')}</th>
                  <th>{t('admin.user.email')}</th>
                  <th>{t('admin.user.created_at')}</th>
                  <th>{t('admin.user.status')}</th>
                  <th>{t('admin.user.operation')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <UserTableRow key={user._id} changeStatus={changeStatus} me={me} user={user} {...handlers} />
                ))}
              </tbody>
            </table>
            <Pagination current={currentPage} count={totalPages} onClick={move} />
          </>
        ) : (
          <p>{t('admin.user.not_found')}</p>
        )
      ) : null}
    </>
  )
}

export default UserTable
