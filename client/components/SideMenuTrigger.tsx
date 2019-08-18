// This is the root component for #search-page

import React from 'react'

import Emitter from '../emitter'
import Crowi from 'client/util/Crowi'
import Icon from 'components/Common/Icon'

interface Props {
  crowi: Crowi
}

interface State {
  menuOpen: boolean
}

export default class SideMenuTrigger extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      menuOpen: false,
    }

    this.handleMenuOpen = this.handleMenuOpen.bind(this)

    Emitter.on('closeSideMenu', () => {
      this.closeMenu()
    })
  }

  handleMenuOpen() {
    const toMenuOpen = !this.state.menuOpen
    Emitter.emit('sideMenuHandle', toMenuOpen)
    this.setState({ menuOpen: toMenuOpen })
  }

  closeMenu() {
    const toMenuOpen = false
    Emitter.emit('sideMenuHandle', toMenuOpen)
    this.setState({ menuOpen: toMenuOpen })
  }

  render() {
    return (
      <a onClick={this.handleMenuOpen}>
        <Icon name="menu" />
      </a>
    )
  }
}
