import React from 'react'
import i18n from 'client/i18n'
import Crowi from 'client/utils/Crowi'
import AdminPage from './AdminPage'

i18n()

const crowi = new Crowi({ user: {}, csrfToken: '' }, window)

export default { title: 'Admin/AdminPage' }

export const Default = () => <AdminPage crowi={crowi} />
