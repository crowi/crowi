import React from 'react'
import { storiesOf } from '@storybook/react'
import PageCreationModal from './PageCreationModal'
import Crowi from 'client/util/Crowi'

const crowi = {
  user: {
    name: 'storybook',
  },
} as Crowi

storiesOf('Modal/PageCreationModal', module).add('Default', () => <PageCreationModal crowi={crowi} />)
