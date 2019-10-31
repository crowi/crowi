import React from 'react'
import { createUser } from 'client/fixtures'
import UserList from './UserList'

export default { title: 'SeenUserList/UserList' }

const createUsers = (size: number) => [...Array(size)].map(createUser)

export const Default = () => <UserList users={createUsers(5)} />

export const Omitted = () => <UserList users={createUsers(50)} />
