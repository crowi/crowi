import React from 'react'
import Crowi from 'client/util/Crowi'
import HeaderNotification from './HeaderNotification'
import { createAppContext } from 'client/fixtures/createAppContext'

export default { title: 'HeaderNotification' }

const appContext = createAppContext()

const crowi = new Crowi(appContext, window)

export const Default = () => <HeaderNotification crowi={crowi} me="" />
