import React, { FC } from 'react'
import styled, { css } from 'styled-components'
import { CommonProps } from 'client/types/component'
import { Notification as NotificationType } from 'client/types/crowi'
import { border } from 'client/constants/components'
import NotificationItemContent from './NotificationItemContent'
import { IconName } from 'components/Common/Icon'

const StyledNotificationItem = styled.li`
  list-style-type: none;

  &:not(:last-child) {
    border-bottom: 1px solid ${border.color};
  }
`

interface NotificationProps {
  isUnread: boolean
}

const Notification = styled.div<NotificationProps>`
  background-color: #fff;
  cursor: pointer;
  padding: 0.5em 1em;

  display: flex;
  flex-direction: row;
  align-items: center;

  &:hover {
    background-color: #eee;
  }

  ${({ unread }) =>
    unread &&
    css`
      background-color: #f0f4f3;
    `}
`

type Props = CommonProps & {
  children: React.ReactNode
  notification: NotificationType
  onClick: () => void
  icon: IconName
}

const NotificationItem: FC<Props> = (props) => {
  const { notification, onClick = () => {}, icon, children, ...others } = props
  const isUnread = notification && notification.status !== 'OPENED'

  return (
    <StyledNotificationItem {...others}>
      <Notification isUnread={isUnread} onClick={onClick}>
        <NotificationItemContent notification={notification} icon={icon}>
          {children}
        </NotificationItemContent>
      </Notification>
    </StyledNotificationItem>
  )
}

export default NotificationItem
