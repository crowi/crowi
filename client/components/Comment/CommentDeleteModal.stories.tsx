import React from 'react'
import faker from 'faker'
import Crowi from 'client/util/Crowi'
import { createAppContext } from 'client/fixtures/createAppContext'
import CommentDeleteModal from './CommentDeleteModal'

const appContext = createAppContext()

const crowi = new Crowi(appContext, window)

export default { title: 'Comment/CommentDeleteModal' }

const comment = {
  id: faker.random.uuid(),
  page_id: faker.random.uuid(),
  body: faker.lorem.sentence(),
}

export const Default = () => <CommentDeleteModal isOpen={true} toggle={() => ''} comment={comment} deleteComment={() => ''} />
