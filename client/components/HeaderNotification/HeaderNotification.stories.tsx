import React from 'react'
import Crowi from 'client/util/Crowi'
import { HeaderNotification } from 'components/HeaderNotification/HeaderNotification'

export default { title: 'HeaderNotification' }

const crowi = new Crowi({ user: {}, csrfToken: '' }, window)

export const Default = () => <HeaderNotification crowi={crowi} me="" />
