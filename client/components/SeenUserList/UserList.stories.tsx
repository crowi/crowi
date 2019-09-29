import React from 'react'
import faker from 'faker'
import UserList from './UserList'

export default { title: 'SeenUserList/UserList' }

const createUser = () => ({
  _id: faker.random.uuid(),
  image: '',
  name: faker.name.findName(),
  username: faker.internet.userName(),
})

const createUsers = (size: number) => [...Array(size)].map(createUser)

export const Default = () => <UserList users={createUsers(5)} />

export const Omitted = () => <UserList users={createUsers(50)} />
