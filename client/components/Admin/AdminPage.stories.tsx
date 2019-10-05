import React from 'react'
import i18n from 'client/i18n'
import Crowi from 'client/util/Crowi'
import { AdminPage } from 'components/Admin/AdminPage'

i18n()

const crowi = new Crowi({ user: {}, csrfToken: '' }, window)

export default { title: 'Admin/AdminPage' }

export const Default = () => <AdminPage crowi={crowi} />
