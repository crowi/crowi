import React, { FC, useState, useCallback } from 'react'

import Crowi from 'client/util/Crowi'
import Icon from 'components/Common/Icon'
import NavigationDrawer from 'client/components/NavigationDrawer/NavigationDrawer'

interface Props {
  crowi: Crowi
}

const NavigationDrawerContainer: FC<Props> = ({ crowi }) => {
  const [isOpen, setIsOpen] = useState(false)

  // FIXME: Replace with React
  const containerElement = document.getElementById('crowi-main-container')
  const openClassName = 'navigation-drawer-open'

  const open = useCallback(() => {
    if (containerElement) {
      containerElement.className += ` ${openClassName}`
    }

    setIsOpen(true)
  }, [setIsOpen])

  const close = useCallback(() => {
    if (containerElement) {
      containerElement.className = containerElement.className.replace(` ${openClassName}`, '')
    }

    setIsOpen(false)
  }, [setIsOpen])

  return (
    <>
      <a onClick={open}>
        <Icon name="menu" />
      </a>
      <NavigationDrawer crowi={crowi} isOpen={isOpen} handleClose={close} />
    </>
  )
}

export default NavigationDrawerContainer
