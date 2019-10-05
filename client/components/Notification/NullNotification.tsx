import React from 'react'
import styled from 'styled-components'

const StyledNullNotification = styled.li`
  padding: 1em;
  list-style-type: none;
  text-align: center;
`

export const NullNotification = () => <StyledNullNotification>You had no notifications, yet.</StyledNullNotification>
