import React from 'react'
import { storiesOf } from '@storybook/react'
import Icon from './Icon'

storiesOf('Common/Icon', module)
  .add('Default', () => <Icon name="helpCircle" />)
  .add('Spin', () => <Icon name="helpCircle" spin={true} />)
