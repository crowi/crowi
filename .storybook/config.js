import { configure } from '@storybook/react'

configure(require.context('../client/components', true, /\.stories\.tsx$/), module)
