// @flow
import React from 'react'

type Props = {
  children: number | string | React.Element | Array<any>,
  title: string,
}

export default class TabItem extends React.Component {
  props: Props
  render() {
    return this.props.children
  }
}

TabItem.defaultProps = {
  title: '',
}
