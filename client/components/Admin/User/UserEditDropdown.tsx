import React, { useState, FC } from 'react'
import { Button, Alert, Dropdown, DropdownToggle, DropdownMenu, DropdownItem } from 'reactstrap'
import { STATUS } from './UserTable'
import { useTranslation } from 'react-i18next'

function OnlyStatusFactory(user) {
  return ({ status, children }) => user.status === status && children
}

interface Props {
  me: any
  user: any
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

const UserEditDropdown: FC<Props> = ({ me, user, ...props }) => {
  const [t] = useTranslation()
  const { admin, username } = user
  const [open, setOpen] = useState(false)
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
  const OnlyStatus = OnlyStatusFactory(user)

  return (
    <Dropdown isOpen={open} toggle={() => setOpen(!open)}>
      <DropdownToggle color="light" caret>
        {t('admin.user.edit.dropdown.edit')}
      </DropdownToggle>
      <DropdownMenu right>
        <div className="dropdown-menu-buttons">
          <DropdownItem header>{t('admin.user.edit.dropdown.edit_menu')}</DropdownItem>
          <Button color="light" onClick={() => handleClickEdit(user)}>
            {t('admin.user.edit.dropdown.edit')}
          </Button>
          <Button color="light" onClick={() => handleClickResetPassword(user)}>
            {t('admin.user.edit.dropdown.reset_password')}
          </Button>
          <DropdownItem header>{t('admin.user.edit.dropdown.status')}</DropdownItem>
          <OnlyStatus status={STATUS.REGISTERED}>
            <Button color="info" onClick={() => handleClickApprove(user)}>
              {t('admin.user.edit.dropdown.approve')}
            </Button>
          </OnlyStatus>
          <OnlyStatus status={STATUS.ACTIVE}>
            <Button color="warning" onClick={() => handleClickSuspend(user)}>
              {t('admin.user.edit.dropdown.suspend')}
            </Button>
          </OnlyStatus>
          <OnlyStatus status={STATUS.SUSPENDED}>
            <Button color="light" onClick={() => handleClickRestore(user)}>
              {t('admin.user.edit.dropdown.restore')}
            </Button>
          </OnlyStatus>
          {/* label は同じだけど、こっちは論理削除 */}
          <Button color="danger" onClick={() => handleClickRemove(user)}>
            {t('admin.user.edit.dropdown.delete')}
          </Button>
          {/* label は同じだけど、こっちは物理削除 */}
          <OnlyStatus status={STATUS.INVITED}>
            <Button color="danger" onClick={() => handleClickRemoveCompletely(user)}>
              {t('admin.user.edit.dropdown.delete_completely')}
            </Button>
          </OnlyStatus>
          <OnlyStatus status={STATUS.ACTIVE}>
            {/* activated な人だけこのメニューを表示 */}
            <DropdownItem header>{t('admin.user.edit.dropdown.admin_menu')}</DropdownItem>

            {admin ? (
              username !== me.username ? (
                <Button color="danger" onClick={() => handleClickRevokeAdmin(user)}>
                  {t('admin.user.edit.dropdown.remove_admin')}
                </Button>
              ) : (
                <DropdownItem>
                  <Alert color="danger">{t('admin.user.edit.dropdown.remove_caution')}</Alert>
                </DropdownItem>
              )
            ) : (
              <Button color="primary" onClick={() => handleClickGrantAdmin(user)}>
                {t('admin.user.edit.dropdown.make_admin')}
              </Button>
            )}
          </OnlyStatus>
        </div>
      </DropdownMenu>
    </Dropdown>
  )
}

export default UserEditDropdown
