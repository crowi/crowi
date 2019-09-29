import React from 'react'
import faker from 'faker'
import { UncontrolledDropdown, DropdownToggle } from 'reactstrap'
import DropdownMenu from './DropdownMenu'
import { Revision } from 'client/types/crowi'

export default { title: 'HeaderNotification/DropdownMenu' }

const createUser = () => ({
  _id: '',
  image: '',
  name: faker.name.findName(),
  username: faker.internet.userName(),
})

const createPage = () => ({
  _id: '',
  path: `/${faker.lorem.slug()}`,
  revision: {} as Revision,
  redirectTo: '',
  status: '',
  creator: createUser(),
  lastUpdateUser: createUser(),
  liker: [],
  seenUsers: [],
  commentCount: 0,
  bookmarkCount: 0,
  grant: 1,
})

const notifications = [
  {
    _id: '',
    user: faker.internet.userName(),
    targetModel: 'Page' as const,
    target: createPage(),
    action: 'COMMENT' as const,
    status: '',
    actionUsers: [...Array(2)].map(createUser),
    createdAt: '2019-09-28 01:23:45.678',
  },
  {
    _id: '',
    user: faker.internet.userName(),
    targetModel: 'Page' as const,
    target: createPage(),
    action: 'LIKE' as const,
    status: '',
    actionUsers: [...Array(2)].map(createUser),
    createdAt: '2019-09-28 01:23:45.678',
  },
]

export const Default = () => (
  <UncontrolledDropdown className="notification-wrapper">
    <DropdownToggle caret>Show</DropdownToggle>
    <DropdownMenu loaded={true} notifications={notifications} notificationClickHandler={() => {}} />
  </UncontrolledDropdown>
)

export const Loading = () => (
  <UncontrolledDropdown className="notification-wrapper">
    <DropdownToggle caret>Show</DropdownToggle>
    <DropdownMenu loaded={false} notifications={[]} notificationClickHandler={() => {}} />
  </UncontrolledDropdown>
)
