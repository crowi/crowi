import React from 'react'
import { Page } from 'client/types/crowi'

interface Props {
  page: Page
  excludePathString: string
}

export default class PagePath extends React.Component<Props> {
  static defaultProps = { page: {}, excludePathString: '' }

  getShortPath(path: string) {
    const name = path

    // /.../YYYY/MM/DD 形式のページ
    if (name.match(/^.*?([^/]+\/\d{4}\/\d{2}\/\d{2})\/?$/)) {
      return name.replace(/^.*?([^/]+\/\d{4}\/\d{2}\/\d{2})\/?$/, '$1')
    }

    // /.../YYYY/MM 形式のページ
    if (name.match(/^.*?([^/]+\/\d{4}\/\d{2})\/?$/)) {
      return name.replace(/^.*?([^/]+\/\d{4}\/\d{2})\/?$/, '$1')
    }

    // /.../YYYY 形式のページ
    if (name.match(/^.*?([^/]+\/\d{4})\/?$/)) {
      return name.replace(/^.*?([^/]+\/\d{4})\/?$/, '$1')
    }

    // ページの末尾を拾う
    const suffix = name.replace(/.+\/(.+)?$/, '$1')
    return suffix || name
  }

  render() {
    const page = this.props.page
    const pagePath = page.path.replace(this.props.excludePathString.replace(/^\//, ''), '')
    const shortPath = this.getShortPath(pagePath)
    const pathPrefix = pagePath.slice(0, -shortPath.length)

    return (
      <span className="page-path">
        {pathPrefix}
        <strong>{shortPath}</strong>
      </span>
    )
  }
}
