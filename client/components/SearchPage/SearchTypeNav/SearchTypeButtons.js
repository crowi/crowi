import React from 'react'
import PropTypes from 'prop-types'
import { Nav, NavItem } from 'react-bootstrap'

class SearchTypeButtons extends React.Component {
  render() {
    const { searchTypes, activeType, changeType } = this.props
    const { key: activeKey } = activeType
    return (
      <Nav bsClass="nav navbar-nav hidden-xs" activeKey={activeKey} onSelect={changeType}>
        {searchTypes.map(({ key, icon, name }) => (
          <NavItem key={key} eventKey={key} href="#">
            {icon}
            {name}
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
