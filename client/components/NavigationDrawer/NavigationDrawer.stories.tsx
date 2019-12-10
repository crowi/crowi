import React from 'react'
import NavigationDrawer from './NavigationDrawer'
import Crowi from '../../utils/Crowi'
import i18n from '../../i18n'
import { createAppContext } from 'client/fixtures/createAppContext'

i18n()

const appContext = createAppContext({ user: { name: 'Crowi', username: 'storybook ' } })

const crowi = new Crowi(appContext, window)

export default { title: 'NavigationDrawer' }

export const Default = () => <NavigationDrawer crowi={crowi} isOpen={true} />
