import React from 'react'
import faker from 'faker'
import ListView from './ListView'
import { Revision } from 'client/types/crowi'

export default { title: 'PageList/ListView' }

const createUser = () => ({
  _id: faker.random.uuid(),
  image: '',
  name: faker.name.findName(),
  username: faker.internet.userName(),
})

const pages = [
  {
    _id: faker.random.uuid(),
    path: '/user/sotarok',
    revision: {} as Revision,
    redirectTo: '',
    status: '',
    creator: createUser(),
    lastUpdateUser: createUser(),
    liker: Array(50),
    seenUsers: Array(1000),
    commentCount: 0,
    bookmarkCount: 50,
    grant: 1,
  },
  {
    _id: faker.random.uuid(),
    path: '/crowi/',
    revision: {} as Revision,
    redirectTo: '',
    status: '',
    creator: createUser(),
    lastUpdateUser: createUser(),
    liker: Array(5),
    seenUsers: Array(10),
    commentCount: 0,
    bookmarkCount: 20,
    grant: 1,
  },
  {
    _id: faker.random.uuid(),
    path: '/user/lightnet328/memo/2019/09/28',
    revision: {} as Revision,
    redirectTo: '',
    status: '',
    creator: createUser(),
    lastUpdateUser: createUser(),
    liker: [],
    seenUsers: [],
    commentCount: 0,
    bookmarkCount: 0,
    grant: 4,
  },
]

export const Default = () => <ListView pages={pages} />
