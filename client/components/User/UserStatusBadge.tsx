import React, { FC } from 'react'
import { Badge } from 'reactstrap'

export const STATUS = {
  REGISTERED: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  DELETED: 4,
  INVITED: 5,
} as const

export const STATUS_COLORS = {
  [STATUS.REGISTERED]: 'info',
  [STATUS.ACTIVE]: 'success',
  [STATUS.SUSPENDED]: 'warning',
  [STATUS.DELETED]: 'danger',
  [STATUS.INVITED]: 'info',
} as const

export const STATUS_LABELS = {
  [STATUS.REGISTERED]: '承認待ち',
  [STATUS.ACTIVE]: 'Active',
  [STATUS.SUSPENDED]: 'Suspended',
  [STATUS.DELETED]: 'Deleted',
  [STATUS.INVITED]: '招待済み',
} as const

interface Props {
  user: {
    status: (typeof STATUS)[keyof typeof STATUS] // FIXME: I want `valueof` to replace this type with `valueof STATUS`
  }
}

const UserStatusBadge: FC<Props> = ({ user }) => {
  const status = user.status in Object.values(STATUS) ? user.status : null
  if (status === null) return null
  const color = STATUS_COLORS[status]

  return <Badge color={color}>{STATUS_LABELS[status]}</Badge>
}

export default UserStatusBadge
