import React from 'react'
import Crowi from 'client/utils/Crowi'
import HeaderNotification from './HeaderNotification'

export default { title: 'HeaderNotification' }

const crowi = new Crowi({ user: {}, csrfToken: '' }, window)

export const Default = () => <HeaderNotification crowi={crowi} me="" />
