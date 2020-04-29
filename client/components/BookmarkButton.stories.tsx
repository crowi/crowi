import React from 'react'
import Crowi from 'client/util/Crowi'
import BookmarkButton from './BookmarkButton'
import { createAppContext } from 'client/fixtures/createAppContext'

export default { title: 'BookmarkButton' }

const appContext = createAppContext()

const crowi = new Crowi(appContext, window)

export const Default = () => <BookmarkButton crowi={crowi} pageId={null} />
