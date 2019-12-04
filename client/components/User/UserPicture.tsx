import React from 'react'
import { User } from 'client/types/crowi'
import { CommonProps } from 'client/types/component'
import { getUserPicture } from 'client/services/user'

type Props = CommonProps & {
  user: User | undefined
  size: string
}

// TODO UserComponent?
export default class UserPicture extends React.Component<Props> {
  static defaultProps = {
    user: {},
    size: null,
  }

  getClassName() {
    const className = this.props.className ? [] : ([] as string[])

    className.push('picture')
    className.push('picture-rounded')

    if (this.props.size) {
      className.push('picture-' + this.props.size)
    }

    return className.join(' ')
  }

  render() {
    const { user, size, className, ...props } = this.props

    return <img src={getUserPicture(user)} alt={user ? user.username : ''} className={this.getClassName()} {...props} />
  }
}
