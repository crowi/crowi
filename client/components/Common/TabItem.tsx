import React from 'react'

interface Props {
  title: string
  children: React.ReactNode
}

export type TabItemProps = Props

export class TabItem extends React.Component<Props> {
  static defaulProps = { title: '' }

  render() {
    return this.props.children
  }
}
