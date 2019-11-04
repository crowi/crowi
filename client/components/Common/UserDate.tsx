import React from 'react'
import format, { formatDistanceFromNow } from 'client/util/formatDate'

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
export default function UserDate({ dateTime, format: formatString = 'yyyy/MM/dd HH:mm:ss', className = '' }: Props) {
  const dtString = (() => {
    if (formatString === 'fromNow') return formatDistanceFromNow(dateTime)
    return format(dateTime, formatString)
  })()
  return <span className={className}>{dtString}</span>
}
