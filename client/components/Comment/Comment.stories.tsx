import React from 'react'
import Crowi from 'client/util/Crowi'
import Comment from './Comment'
import { createAppContext } from 'client/fixtures/createAppContext'

const appContext = createAppContext()

const crowi = new Crowi(appContext, window)

export default { title: 'Comment/Comment' }

export const Default = () => <Comment crowi={crowi} pageId={null} revisionId={null} revisionCreatedAt={null} isSharePage={false} />
