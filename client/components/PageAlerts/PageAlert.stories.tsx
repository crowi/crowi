import React from 'react'
import faker from 'faker'
import PageAlert from './PageAlert'

export default { title: 'PageAlerts/PageAlert' }

const user = {
  _id: '',
  image: '',
  name: faker.name.findName(),
  username: faker.internet.userName(),
}

export const Default = () => <PageAlert data={{ user }} />
