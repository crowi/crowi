// @flow
import React from 'react'

import Page from './Page'

type Props = { pages: Array<any> }

export default class ListView extends React.Component<Props> {
  static defaultProps = {
    pages: [],
  }

  render() {
    const listView = this.props.pages.map(page => {
      return <Page page={page} key={'page-list:list-view:' + page._id} />
    })

    return (
      <div className="page-list">
        <ul className="page-list-ul">{listView}</ul>
      </div>
    )
  }
}
