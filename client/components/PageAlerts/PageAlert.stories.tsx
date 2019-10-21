import React from 'react'
import { createUser } from 'client/fixtures'
import PageAlert from './PageAlert'

export default { title: 'PageAlerts/PageAlert' }

const user = createUser()

export const Default = () => <PageAlert data={{ user }} />
