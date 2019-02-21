import React from 'react'
import PropTypes from 'prop-types'
import moment from 'moment'
import { Badge } from 'reactstrap'
import UserPicture from 'components/User/UserPicture'
import UserStatusBadge from 'components/User/UserStatusBadge'
import UserEditDropdown from './UserEditDropdown'

function UserTableRow({ me, user, ...props }) {
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

UserTableRow.propTypes = {
  me: PropTypes.object.isRequired,
  user: PropTypes.object.isRequired,
}

export default UserTableRow
