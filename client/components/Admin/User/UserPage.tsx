import React, { useContext, useState, useEffect, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from 'reactstrap'
import queryString from 'query-string'

import { AdminContext } from 'components/Admin/AdminPage'
import UserTable from './UserTable'
import UserEditModal from './UserEditModal'
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

  return [
    { success, failure },
    { setSuccess, setFailure, clearStatus },
  ] as const
}

function useInviteUsers(crowi, fetchUsers, setFailure, clearStatus) {
  const [invitedUsers, setInvitedUsers] = useState([])

  const invite = async ({ emails, sendEmail }) => {
    const emailList = emails
      .split('\n')
      .map((s) => s.trim())
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
  const initialPage = Array.isArray(p) ? parseInt(p[0]) : p ? parseInt(p) : 1
  const initialQuery = (Array.isArray(q) ? q[0] : q) || ''

  const [currentPage, setCurrentPage] = useState(initialPage)
  const [query, setQuery] = useState(initialQuery)

  return [
    { currentPage, query },
    { setCurrentPage, setQuery },
  ] as const
}

function useFetchUsers(crowi, setFailure, clearStatus) {
  const [users, setUsers] = useState([])
  const [{ currentPage, query }, { setCurrentPage, setQuery }] = useQuery(crowi)
  const [totalPages, setTotalPages] = useState(1)
  const [search, setSearch] = useState('')
  const pagination = { currentPage, totalPages }
  const fetchUsers = async (options = {}) => {
    clearStatus(null)

    try {
      const { users, pager } = await crowi.apiGet('/admin/users', { uq: search, page: currentPage, ...options })
      setUsers(users)
      setCurrentPage(pager.page)
      setTotalPages(pager.pagesCount)
    } catch ({ message }) {
      setFailure(message)
    }
  }

  const move = (page) => setCurrentPage(page)

  useEffect(() => {
    fetchUsers()
  }, [currentPage])

  useEffect(() => {
    fetchUsers({ page: 1 })
  }, [search])

  return [
    { users, pagination, query },
    { setQuery, setSearch, fetchUsers, move },
  ] as const
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
  const open = (state) => {
    setModal(true)
    if (state) setModalState(state)
  }
  const close = () => {
    setModal(false)
    setModalState({})
  }

  return [
    { isOpen, modalState },
    { toggle, open, close },
  ] as const
}

function useEditUsers(crowi, setSuccess, setFailure, closeUserEditModal, fetchUsers) {
  const [name, setName] = useState('')
  const [emailToBeChanged, setEmailToBeChanged] = useState('')

  const editUserNameAndEmail = async ({ name, emailToBeChanged, user }) => {
    const { _id } = user
    try {
      const { message } = await crowi.apiPost(`/admin/user/${_id}/edit`, { userEditForm: { name, emailToBeChanged } })
      await fetchUsers()
      setSuccess(message)
    } catch (err) {
      await fetchUsers()
      setFailure(err.message)
    }
    closeUserEditModal()
  }

  const clearForm = () => {
    setName('')
    setEmailToBeChanged('')
  }

  return [
    { name, emailToBeChanged },
    { setName, setEmailToBeChanged, editUserNameAndEmail, clearForm },
  ] as const
}

const UserPage: FC<{}> = () => {
  const [t] = useTranslation()
  const { crowi } = useContext(AdminContext)
  const me = crowi.getUser()
  const [{ success, failure }, { setSuccess, setFailure, clearStatus }] = useAlerts()
  const [{ users, pagination, query }, { setQuery, setSearch, fetchUsers, move }] = useFetchUsers(crowi, setFailure, clearStatus)
  const [{ invitedUsers }, { invite, clear }] = useInviteUsers(crowi, fetchUsers, setFailure, clearStatus)

  const [
    { isOpen: isOpenUserEditModal, modalState: userEditModalState },
    { toggle: toggleUserEditModal, open: openUserEditModal, close: closeUserEditModal },
  ] = useModal()
  const { user: editedUser } = userEditModalState
  const [{ name, emailToBeChanged }, { setName, setEmailToBeChanged, editUserNameAndEmail, clearForm }] = useEditUsers(
    crowi,
    setSuccess,
    setFailure,
    closeUserEditModal,
    fetchUsers,
  )

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
        openUserEditModal={({ user }) => {
          setName(user.name)
          setEmailToBeChanged(user.email)
          openUserEditModal({ user })
        }}
        openResetModal={openResetModal}
        changeStatus={changeStatus}
      />

      <InvitedUserModal users={invitedUsers} clear={clear} />
      <UserEditModal
        isOpen={isOpenUserEditModal}
        toggle={toggleUserEditModal}
        editUserNameAndEmail={editUserNameAndEmail}
        clearForm={clearForm}
        name={name}
        emailToBeChanged={emailToBeChanged}
        setName={setName}
        setEmailToBeChanged={setEmailToBeChanged}
        user={editedUser}
      />
      <ResetPasswordModal isOpen={isOpenResetModal} toggle={toggleResetModal} user={resetUser} resetPassword={resetPassword} />
      <ResetedPasswordModal isOpen={isOpenResetedModal} toggle={toggleResetedModal} user={resetedUser} password={resetedPassword} />
    </>
  )
}

export default UserPage
