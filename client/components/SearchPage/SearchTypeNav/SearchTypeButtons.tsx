import React from 'react'
import { Nav, NavItem, NavLink } from 'reactstrap'
import { SearchType } from 'components/SearchPage/SearchToolbar'

interface Props {
  searchTypes: SearchType[]
  activeType: SearchType
  changeType: Function
}

class SearchTypeButtons extends React.Component<Props> {
  render() {
    const { searchTypes, activeType, changeType } = this.props
    const { key: activeKey } = activeType
    return (
      <Nav className="navbar-nav d-none d-sm-flex">
        {searchTypes.map(({ key, icon, name }) => (
          <NavItem key={key} active={key === activeKey}>
            <NavLink onClick={() => changeType(key)}>
              {icon} {name}
            </NavLink>
          </NavItem>
        ))}
      </Nav>
    )
  }
}

export default SearchTypeButtons
