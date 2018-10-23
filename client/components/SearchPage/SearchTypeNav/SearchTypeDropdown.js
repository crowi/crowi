import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { DropdownButton, MenuItem } from 'react-bootstrap'

class SearchTypeDropdown extends React.Component {
  render() {
    const { t, searchTypes, activeType, changeType } = this.props
    const { key } = activeType
    return (
      <div className="pull-right hidden-sm hidden-md hidden-lg">
        <DropdownButton title={t('page_type')} key={key} id="search-type-dropdown" pullRight>
          {searchTypes.map(({ key, icon, name }) => (
            <MenuItem key={key} eventKey={key} onClick={() => changeType(key)} active={key === activeType.key}>
              {icon}
              {name}
            </MenuItem>
          ))}
        </DropdownButton>
      </div>
    )
  }
}

SearchTypeDropdown.propTypes = {
  t: PropTypes.func.isRequired,
  searchTypes: PropTypes.array.isRequired,
  activeType: PropTypes.object.isRequired,
  changeType: PropTypes.func.isRequired,
}
SearchTypeDropdown.defaultProps = {}

export default translate()(SearchTypeDropdown)
