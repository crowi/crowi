import React from 'react'
import i18n from 'client/i18n'
import Crowi from 'client/util/Crowi'
import AdminPage from './AdminPage'
import { createAppContext } from 'client/fixtures/createAppContext'

const appContext = createAppContext()

i18n()

const crowi = new Crowi(appContext, window)

export default { title: 'Admin/AdminPage' }

export const Default = () => <AdminPage crowi={crowi} />
