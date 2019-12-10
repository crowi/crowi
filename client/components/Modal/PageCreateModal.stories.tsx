import React from 'react'
import PageCreateModal from './PageCreateModal'
import Crowi from '../../utils/Crowi'
import i18n from '../../i18n'
import { createAppContext } from 'client/fixtures/createAppContext'

i18n()

const appContext = createAppContext({ user: { username: 'storybook ' } })

const crowi = new Crowi(appContext, window)

export default { title: 'Modal/PageCreateModal' }

export const Default = () => <PageCreateModal crowi={crowi} isOpen={true} toggle={() => {}} />
