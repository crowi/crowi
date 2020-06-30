import React from 'react'
import styled from 'styled-components'
import Icon, { IconName } from './Icon'
import * as Icons from './Icons'

export default { title: 'Common/Icons' }

const IconList = styled.ul`
  display: flex;
  flex-wrap: wrap;
`

const IconListTooltip = styled.div`
  position: absolute;
  display: none;
  bottom: 0;
  padding: 16px;
  border-radius: 4px;
  color: #ffffff;
  background: #333333;
  white-space: nowrap;
`

const IconListItem = styled.li`
  position: relative;
  display: flex;
  flex-direction: column;
  width: 120px;
  height: 120px;
  align-items: center;
  justify-content: center;
  list-style: none;
  margin: 5px;
  cursor: pointer;

  &:hover ${IconListTooltip} {
    display: block;
  }
`

const StyledIcon = styled(Icon)`
  width: 30px;
`

const IconListText = styled.div`
  width: 100px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
  margin-top: 10px;
`

export const Default = () => (
  <IconList>
    {Object.keys(Icons).map((name) => (
      <IconListItem key={name} data-name={name}>
        <StyledIcon name={name as IconName} />
        <IconListText>{name}</IconListText>
        <IconListTooltip>{name}</IconListTooltip>
      </IconListItem>
    ))}
  </IconList>
)
