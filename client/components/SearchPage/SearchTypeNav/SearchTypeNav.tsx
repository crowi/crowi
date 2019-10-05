import React from 'react'
import { SearchType } from 'components/SearchPage/SearchToolbar'
import { SearchTypeButtons } from 'components/SearchPage/SearchTypeNav/SearchTypeButtons'
import { SearchTypeDropdown } from 'components/SearchPage/SearchTypeNav/SearchTypeDropdown'

interface Props {
  searchTypes: SearchType[]
  activeType: SearchType
  changeType: Function
}

export class SearchTypeNav extends React.Component<Props> {
  render() {
    return (
      <div>
        <SearchTypeButtons {...this.props} />
        <SearchTypeDropdown {...this.props} />
      </div>
    )
  }
}
