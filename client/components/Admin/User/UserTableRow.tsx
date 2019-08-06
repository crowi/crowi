import React, { FC } from 'react'
import moment from 'moment'
import { Badge } from 'reactstrap'
import UserPicture from 'components/User/UserPicture'
import UserStatusBadge from 'components/User/UserStatusBadge'
import UserEditDropdown from './UserEditDropdown'

interface Props {
  me: any
  user: any
  changeStatus: (user: any, string: string) => void
  handleClickEdit: (user: any) => void
  handleClickResetPassword: (user: any) => void
  handleClickApprove: (user: any) => void
  handleClickSuspend: (user: any) => void
  handleClickRestore: (user: any) => void
  handleClickRemove: (user: any) => void
  handleClickRemoveCompletely: (user: any) => void
  handleClickRevokeAdmin: (user: any) => void
  handleClickGrantAdmin: (user: any) => void
}

const UserTableRow: FC<Props> = ({ me, user, ...props }) => {
  const { admin, username, name, email, createdAt } = user
  const {
    handleClickEdit,
    handleClickResetPassword,
    handleClickApprove,
    handleClickSuspend,
    handleClickRestore,
    handleClickRemove,
    handleClickRemoveCompletely,
    handleClickRevokeAdmin,
    handleClickGrantAdmin,
  } = props
  const handlers = {
    handleClickEdit,
    handleClickResetPassword,
    handleClickApprove,
    handleClickSuspend,
    handleClickRestore,
    handleClickRemove,
    handleClickRemoveCompletely,
    handleClickRevokeAdmin,
    handleClickGrantAdmin,
  }

  return (
    <tr>
      <td>
        <UserPicture user={user} />
      </td>
      <td>
        <strong>{username}</strong>
      </td>
      <td>{name}</td>
      <td>{email}</td>
      <td>{moment(createdAt).format('YYYY-MM-DD')}</td>
      <td>
        <div className="d-inline-flex flex-column">
          <UserStatusBadge user={user} />
          {admin && (
            <Badge className="mt-2" color="primary">
              Admin
            </Badge>
          )}
        </div>
      </td>
      <td>
        <UserEditDropdown me={me} user={user} {...handlers} />
      </td>
    </tr>
  )
}

export default UserTableRow
