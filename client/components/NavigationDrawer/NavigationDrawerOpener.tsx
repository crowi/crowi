import React, { FC, useEffect, useCallback } from 'react'

import Emitter from '../../emitter'
import Crowi from 'client/util/Crowi'
import Icon from 'components/Common/Icon'

interface Props {
  crowi: Crowi
}

const NavigationDrawerOpener: FC<Props> = props => {
  const openMenu = useCallback(() => {
    Emitter.emit('sideMenuHandle', true)
  }, [])

  const closeMenu = useCallback(() => {
    Emitter.emit('sideMenuHandle', false)
  }, [])

  useEffect(() => {
    Emitter.on('closeSideMenu', () => {
      closeMenu()
    })
  })

  return (
    <a onClick={openMenu}>
      <Icon name="menu" />
    </a>
  )
}

export default NavigationDrawerOpener
