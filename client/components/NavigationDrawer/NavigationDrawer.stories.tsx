import React from 'react'
import NavigationDrawer from './NavigationDrawer'
import Crowi from 'client/util/Crowi'
import i18n from 'client/i18n'
import { createAppContext } from 'client/fixtures/createAppContext'

const appContext = createAppContext({ user: { name: 'Crowi', username: 'storybook ' } })

i18n()

const crowi = new Crowi(appContext, window)

export default { title: 'NavigationDrawer' }

export const Default = () => <NavigationDrawer crowi={crowi} isOpen={true} />
