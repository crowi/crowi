import React from 'react'
import { storiesOf } from '@storybook/react'
import PageCreateModal from './PageCreateModal'
import Crowi from 'client/util/Crowi'

const crowi = {
  user: {
    name: 'storybook',
  },
} as Crowi

storiesOf('Modal/PageCreateModal', module).add('Default', () => <PageCreateModal crowi={crowi} />)
