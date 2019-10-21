import { configure } from '@storybook/react'

const loadStories = () => {
  const req = require.context('../client/components', true, /\.stories\.tsx$/)
  req.keys().forEach(req)
}

configure(loadStories, module)
