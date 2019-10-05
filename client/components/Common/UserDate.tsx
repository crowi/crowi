import React from 'react'
import moment from 'moment'

interface Props {
  dateTime: string
  format?: string
  className?: string
}

/**
 * UserDate
 *
 * display date depends on user timezone of user settings
 */
export class UserDate extends React.Component<Props> {
  static defaultProps = { format: 'YYYY/MM/DD HH:mm:ss', className: '' }

  render() {
    const format = this.props.format
    const dt = moment(this.props.dateTime)

    let dtFormat
    if (format === 'fromNow') {
      dtFormat = dt.fromNow()
    } else {
      dtFormat = dt.format(format)
    }

    return <span className={this.props.className}>{dtFormat}</span>
  }
}
