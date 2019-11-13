import React from 'react'
import MDIIcon from '@mdi/react'
import classNames from 'classnames'
import * as Icons from './Icons'

export type IconName = keyof typeof Icons

// TODO: support size and so far
interface Props {
  name: IconName
  spin: boolean
  className?: string
}

export default class Icon extends React.Component<Props> {
  static defaultProps = { spin: false }

  render() {
    const { className, name, spin, ...props } = this.props

    return <MDIIcon className={classNames('mdi-svg', className)} path={Icons[name]} spin={spin} {...props} />
  }
}
