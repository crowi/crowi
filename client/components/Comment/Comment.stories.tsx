import React from 'react'
import Crowi from 'client/utils/Crowi'
import Comment from './Comment'

const crowi = new Crowi({ user: {}, csrfToken: '' }, window)

export default { title: 'Comment/Comment' }

export const Default = () => <Comment crowi={crowi} pageId={null} revisionId={null} revisionCreatedAt={null} isSharePage={false} />
