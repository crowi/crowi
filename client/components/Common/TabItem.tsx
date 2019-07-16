import React from 'react'

export interface Props {
  title: string
  children: React.ReactNode
}

export default class TabItem extends React.Component<Props> {
  static defaulProps = { title: '' }

  render() {
    return this.props.children
  }
}
