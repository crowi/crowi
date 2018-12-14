import React from 'react'
import SearchTypeButtons from 'components/SearchPage/SearchTypeNav/SearchTypeButtons'
import SearchTypeDropdown from 'components/SearchPage/SearchTypeNav/SearchTypeDropdown'
import { SearchType } from 'components/SearchPage/SearchToolbar'

interface Props {
  searchTypes: SearchType[]
  activeType: SearchType
  changeType: Function
}

class SearchTypeNav extends React.Component<Props> {
  render() {
    return (
      <div>
        <SearchTypeButtons {...this.props} />
        <SearchTypeDropdown {...this.props} />
      </div>
    )
  }
}

export default SearchTypeNav
