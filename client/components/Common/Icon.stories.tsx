import React from 'react'
import { storiesOf } from '@storybook/react'
import Icon from './Icon'

storiesOf('Common/Icon', module)
  .add('Default', () => <Icon name="help-circle" spin={false} />)
  .add('Spin', () => <Icon name="help-circle" spin={true} />)
