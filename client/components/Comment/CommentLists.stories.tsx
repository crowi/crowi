import React from 'react'
import faker from 'faker'
import Crowi from 'client/util/Crowi'
import CommentLists from './CommentLists'
import { createAppContext } from 'client/fixtures/createAppContext'

const appContext = createAppContext()

const crowi = new Crowi(appContext, window)

export default { title: 'Comment/CommentLists' }

const createComment = () => ({
  _id: faker.random.uuid(),
  page: '',
  creator: { username: faker.internet.userName() } as any,
  revision: '',
  comment: faker.lorem.sentence(),
  commentPosition: 0,
  createdAt: '2019-09-28 01:23:45.678',
})

const comments = {
  newer: [...Array(5)].map(createComment),
  current: [...Array(5)].map(createComment),
  older: [...Array(5)].map(createComment),
}

export const Default = () => <CommentLists crowi={crowi} comments={comments} revisionId={null} />
