import React, { useContext, useState, useEffect, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from 'reactstrap'
import queryString from 'query-string'

import { AdminContext } from 'components/Admin/AdminPage'
import UserTable from './UserTable'
import InviteUserForm from './InviteUserForm'
import InvitedUserModal from './InvitedUserModal'
import ResetPasswordModal from './ResetPasswordModal'
import ResetedPasswordModal from './ResetedPasswordModal'

function useAlerts() {
  const [success, setSuccess] = useState(null)
  const [failure, setFailure] = useState(null)

  const clearStatus = () => {
    setSuccess(null)
    setFailure(null)
  }

  return [{ success, failure }, { setSuccess, setFailure, clearStatus }] as const
}

function useInviteUsers(crowi, fetchUsers, setFailure, clearStatus) {
  const [invitedUsers, setInvitedUsers] = useState([])

  const invite = async ({ emails, sendEmail }) => {
    const emailList = emails
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .join('\n')

    clearStatus(null)

    try {
      const { userList: users = [] } = await crowi.apiPost(`/admin/user/invite`, { inviteForm: { emailList, sendEmail } })
      setInvitedUsers(users)
    } catch (err) {
      setFailure(err.message)
    }

    fetchUsers()
  }

  const clear = () => setInvitedUsers([])

  return [{ invitedUsers }, { invite, clear }] as const
}

function useQuery(crowi) {
  const { search = '' } = crowi.location
  const { page: p = '', uq: q = '' } = queryString.parse(search)
  const initialPage = Array.isArray(p) ? parseInt(p[0]) : p ? parseInt(p) : 0
  const initialQuery = (Array.isArray(q) ? q[0] : q) || ''

  const [page, setPage] = useState(initialPage)
  const [query, setQuery] = useState(initialQuery)

  return [{ page, query }, { setPage, setQuery }] as const
}

function useFetchUsers(crowi, setFailure, clearStatus) {
  const [users, setUsers] = useState([])
  const [{ page, query }, { setPage, setQuery }] = useQuery(crowi)
  const [count, setCount] = useState(0)
  const [search, setSearch] = useState('')
  const pagination = { current: page, count }
  const fetchUsers = async (options = {}) => {
    clearStatus(null)

    try {
      const { users, pager } = await crowi.apiGet('/admin/users', { uq: search, page, ...options })
      setUsers(users)
      setPage(pager.page)
      setCount(pager.pagesCount)
    } catch ({ message }) {
      setFailure(message)
    }
  }

  const move = page => setPage(page)

  useEffect(() => {
    fetchUsers()
  }, [page])

  useEffect(() => {
    fetchUsers({ page: 0 })
  }, [search])

  return [{ users, pagination, query }, { setQuery, setSearch, fetchUsers, move }] as const
}

function useChangeStatus(crowi, fetchUsers, setSuccess, setFailure, clearStatus) {
  return async (user, action) => {
    const { _id } = user

    clearStatus(null)

    try {
      const { message } = await crowi.apiPost(`/admin/user/${_id}/${action}`)
      await fetchUsers()
      setSuccess(message)
    } catch ({ message }) {
      setFailure(message)
    }
  }
}

function useResetPassword(crowi, closeResetModal, openResetedModal) {
  return async ({ _id: userId }) => {
    const { ok, user, newPassword } = await crowi.apiPost('/admin/users.resetPassword', { user_id: userId })
    if (ok) {
      closeResetModal()
      openResetedModal({ user, newPassword })
    }
  }
}

function useModal<T = any>(initialState: T | {} = {}) {
  const [isOpen, setModal] = useState(false)
  const [modalState, setModalState] = useState(initialState)

  const toggle = () => setModal(!isOpen)
  const open = state => {
    setModal(true)
    if (state) setModalState(state)
  }
  const close = () => {
    setModal(false)
    setModalState({})
  }

  return [{ isOpen, modalState }, { toggle, open, close }] as const
}

const UserPage: FC<{}> = () => {
  const [t] = useTranslation()
  const { crowi } = useContext(AdminContext)
  const me = crowi.getUser()
  const [{ success, failure }, { setSuccess, setFailure, clearStatus }] = useAlerts()
  const [{ users, pagination, query }, { setQuery, setSearch, fetchUsers, move }] = useFetchUsers(crowi, setFailure, clearStatus)
  const [{ invitedUsers }, { invite, clear }] = useInviteUsers(crowi, fetchUsers, setFailure, clearStatus)

  const [{ isOpen: isOpenResetModal, modalState: resetModalState }, { toggle: toggleResetModal, open: openResetModal, close: closeResetModal }] = useModal()
  const { user: resetUser } = resetModalState

  const [{ isOpen: isOpenResetedModal, modalState: resetedModalState }, { toggle: toggleResetedModal, open: openResetedModal }] = useModal()
  const { user: resetedUser, newPassword: resetedPassword } = resetedModalState

  const changeStatus = useChangeStatus(crowi, fetchUsers, setSuccess, setFailure, clearStatus)
  const resetPassword = useResetPassword(crowi, closeResetModal, openResetedModal)

  return (
    <>
      <InviteUserForm invite={invite} />
      {success && <Alert color="success">{success}</Alert>}
      {failure && <Alert color="danger">{failure}</Alert>}

      <h2>{t('admin.user.legend')}</h2>
      <UserTable
        me={me}
        users={users}
        pagination={pagination}
        query={query}
        setQuery={setQuery}
        search={setSearch}
        move={move}
        openResetModal={openResetModal}
        changeStatus={changeStatus}
      />

      <InvitedUserModal users={invitedUsers} clear={clear} />
      <ResetPasswordModal isOpen={isOpenResetModal} toggle={toggleResetModal} user={resetUser} resetPassword={resetPassword} />
      <ResetedPasswordModal isOpen={isOpenResetedModal} toggle={toggleResetedModal} user={resetedUser} password={resetedPassword} />
    </>
  )
}

export default UserPage
