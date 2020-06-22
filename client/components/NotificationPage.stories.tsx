import React from 'react'
import Crowi from 'client/util/Crowi'
import NotificationPage from './NotificationPage'
import { createAppContext } from 'client/fixtures/createAppContext'

export default { title: 'NotificationPage' }

const appContext = createAppContext()

const crowi = new Crowi(appContext, window)

export const Default = () => <NotificationPage crowi={crowi} />
