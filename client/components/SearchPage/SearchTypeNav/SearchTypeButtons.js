import React from 'react'
import PropTypes from 'prop-types'
import { Nav, NavItem, NavLink } from 'reactstrap'

class SearchTypeButtons extends React.Component {
  render() {
    const { searchTypes, activeType, changeType } = this.props
    const { key: activeKey } = activeType
    return (
      <Nav className="navbar-nav d-none d-sm-flex">
        {searchTypes.map(({ key, icon, name }) => (
          <NavItem key={key} active={key === activeKey}>
            <NavLink onClick={() => changeType(key)}>
              {icon}
              {name}
            </NavLink>
          </NavItem>
        ))}
      </Nav>
    )
  }
}

SearchTypeButtons.propTypes = {
  searchTypes: PropTypes.array.isRequired,
  activeType: PropTypes.object.isRequired,
  changeType: PropTypes.func.isRequired,
}
SearchTypeButtons.defaultProps = {}

export default SearchTypeButtons
