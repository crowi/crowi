import React from 'react'
import Crowi from 'client/util/Crowi'
import BookmarkButton from './BookmarkButton'

export default { title: 'BookmarkButton' }

const crowi = new Crowi({ user: {}, csrfToken: '' }, window)

export const Default = () => <BookmarkButton crowi={crowi} pageId={null} />
