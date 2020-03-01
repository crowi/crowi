import React, { FC } from 'react'
import classNames from 'classnames'
import { User } from 'client/types/crowi'
import { Me } from 'client/util/Crowi'
import { CommonProps } from 'client/types/component'
import { getUserPicture } from 'client/services/user'

type Props = CommonProps & {
  user: User | Me | undefined
  size?: 'lg' | 'sm' | 'xs'
}

const UserPicture: FC<Props> = ({ user, size, className, ...props }) => {
  const sizeClassName = size ? `picture-${size}` : null

  return <img className={classNames('picture', 'picture-rounded', sizeClassName, className)} src={getUserPicture(user)} alt={user?.username || ''} {...props} />
}

export default UserPicture
