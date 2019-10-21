import React from 'react'
import { storiesOf } from '@storybook/react'
import PageCreateModal from './PageCreateModal'
import Crowi from 'client/util/Crowi'
import i18n from '../../i18n'

i18n()

const crowi = {
  user: {
    name: 'storybook',
  },
} as Crowi

storiesOf('Modal/PageCreateModal', module).add('Default', () => <PageCreateModal crowi={crowi} />)
