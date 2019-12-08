import React from 'react'
import NavigationDrawer from './NavigationDrawer'
import Crowi from '../../utils/Crowi'
import i18n from '../../i18n'

i18n()

const crowi = new Crowi({ user: { name: 'Crowi', username: 'crowi' }, csrfToken: '' }, window)

export default { title: 'NavigationDrawer' }

export const Default = () => <NavigationDrawer crowi={crowi} isOpen={true} />
