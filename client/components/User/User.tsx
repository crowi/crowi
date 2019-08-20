import React from 'react'
import styled from 'styled-components'
import UserPicture from './UserPicture'
import { User as UserType } from 'client/types/crowi'

const StyledUser = styled.span`
  img.picture,
  span {
    margin-right: 4px;
  }
`

interface Props {
  user: UserType
  name: boolean
  username: boolean
}

export default class User extends React.Component<Props> {
  static defaultProps = { name: false, username: false }

  render() {
    const user = this.props.user
    const userLink = '/user/' + user.username

    const username = this.props.username
    const name = this.props.name

    return (
      <StyledUser>
        <a href={userLink}>
          <UserPicture user={user} />

          {username && <span>@{user.username}</span>}
          {name && <span>({user.name})</span>}
        </a>
      </StyledUser>
    )
  }
}
