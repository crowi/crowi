import React from 'react'
import PageDeleteModal from './PageDeleteModal'
import Crowi from '../../util/Crowi'

const crowi = new Crowi({ user: { name: 'storybook' }, csrfToken: '' }, window)

export default { title: 'Modal/PageDeleteModal' }

export const Default = () => <PageDeleteModal crowi={crowi} pageId="" revisionId="" />
