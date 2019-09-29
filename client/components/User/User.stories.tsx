import React from 'react'
import faker from 'faker'
import User from './User'

export default { title: 'User/User' }

const user = {
  _id: '',
  image: '',
  name: faker.name.findName(),
  username: faker.internet.userName(),
}

export const Default = () => <User user={user} />

export const Name = () => <User user={user} name />

export const Username = () => <User user={user} username />

export const NameAndUsername = () => <User user={user} name username />
