import React from 'react'
import faker from 'faker'
import PageAttachmentList from './PageAttachmentList'
import { Revision } from 'client/types/crowi'

export default { title: 'PageAttachment/PageAttachmentList' }

const createUser = () => ({
  _id: faker.random.uuid(),
  image: '',
  name: faker.name.findName(),
  username: faker.internet.userName(),
})

const createPage = () => ({
  _id: faker.random.uuid(),
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

const createAttachment = () => ({
  _id: faker.random.uuid(),
  page: createPage(),
  creator: createUser(),
  filePath: faker.lorem.sentence(),
  fileName: faker.lorem.sentence(),
  originalName: faker.lorem.sentence(),
  fileFormat: 'image/png',
  fileSize: faker.random.number(),
  createdAt: '2019-09-28T01:23:45.678Z',
  url: faker.image.imageUrl(),
})

const attachments = [...Array(5)].map(createAttachment)

const inUse = attachments.reduce((object, { _id }, index) => ({ ...object, [_id]: !(index % 2) }), {} as { [id: string]: boolean })

export const Default = () => <PageAttachmentList attachments={attachments} inUse={inUse} onAttachmentDeleteClicked={() => {}} />
