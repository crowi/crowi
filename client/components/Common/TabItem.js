// @flow
import React from 'react'
import type { Node } from 'react'

type Props = {
  children: Node,
  title: string,
}

export default class TabItem extends React.Component<Props> {
  static defaultProps = {
    title: '',
  }

  render() {
    return this.props.children
  }
}
