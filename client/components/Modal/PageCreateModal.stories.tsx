import React from 'react'
import PageCreateModal from './PageCreateModal'
import Crowi from '../../util/Crowi'
import i18n from '../../i18n'

i18n()

const crowi = new Crowi({ user: { name: 'storybook' }, csrfToken: '' }, window)

export default { title: 'Modal/PageCreateModal' }

export const Default = () => <PageCreateModal crowi={crowi} />
