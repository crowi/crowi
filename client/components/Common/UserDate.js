// @flow
import React from 'react'

import moment from 'moment'

type Props = {
  dateTime: string,
  format?: string,
  className?: string,
}

/**
 * UserDate
 *
 * display date depends on user timezone of user settings
 */
export default class UserDate extends React.Component<Props> {
  static defaultProps = {
    dateTime: 'now',
    format: 'YYYY/MM/DD HH:mm:ss',
    className: '',
  }

  render() {
    const dt = moment(this.props.dateTime).format(this.props.format)

    return <span className={this.props.className}>{dt}</span>
  }
}
