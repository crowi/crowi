import React from 'react'
import PropTypes from 'prop-types'
import SearchTypeButtons from 'components/SearchPage/SearchTypeNav/SearchTypeButtons'
import SearchTypeDropdown from 'components/SearchPage/SearchTypeNav/SearchTypeDropdown'

class SearchTypeNav extends React.Component {
  render() {
    return (
      <div>
        <SearchTypeButtons {...this.props} />
        <SearchTypeDropdown {...this.props} />
      </div>
    )
  }
}

SearchTypeNav.propTypes = {
  searchTypes: PropTypes.array.isRequired,
  activeType: PropTypes.object.isRequired,
  changeType: PropTypes.func.isRequired,
}
SearchTypeNav.defaultProps = {}

export default SearchTypeNav
