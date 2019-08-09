import React from 'react'
import { Page } from 'client/types/crowi'
import path2name from 'common/functions/path2name'

interface Props {
  page: Page
  excludePathString: string
}

export default class PagePath extends React.Component<Props> {
  static defaultProps = { page: {}, excludePathString: '' }

  render() {
    const page = this.props.page
    const pagePath = page.path.replace(this.props.excludePathString.replace(/^\//, ''), '')
    const shortPath = path2name(pagePath)
    const pathPrefix = pagePath.slice(0, -shortPath.length)

    return (
      <span className="page-path">
        {pathPrefix}
        <strong>{shortPath}</strong>
      </span>
    )
  }
}
