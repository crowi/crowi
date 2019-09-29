import React from 'react'
import faker from 'faker'
import { createPage } from 'client/fixtures'
import ListView from './ListView'
import { Revision } from 'client/types/crowi'

export default { title: 'PageList/ListView' }

const pages = [
  {
    ...createPage({
      path: '/user/sotarok',
      liker: Array(50),
      seenUsers: Array(1000),
      bookmarkCount: 50,
    }),
    grant: 1,
  },
  {
    ...createPage({
      path: '/crowi/',
      liker: Array(5),
      seenUsers: Array(10),
      bookmarkCount: 20,
    }),
    grant: 1,
  },
  {
    ...createPage({ path: '/user/lightnet328/memo/2019/09/28' }),
    grant: 4,
  },
]

export const Default = () => <ListView pages={pages} />
