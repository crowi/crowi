import React, { FC } from 'react'
import classNames from 'classnames'

export interface Props {
  type: 'success' | 'danger'
  messages?: string | string[]
}

const Alert: FC<Props> = ({ type, messages }) => {
  return messages && messages.length ? (
    <div className={classNames(['alert', `alert-${type}`])}>
      {typeof messages === 'string' ? (
        messages
      ) : (
        <ul>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  ) : null
}

export default Alert
