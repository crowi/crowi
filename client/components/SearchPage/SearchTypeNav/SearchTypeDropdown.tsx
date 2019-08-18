import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import { Dropdown, DropdownToggle, DropdownMenu, DropdownItem } from 'reactstrap'
import { SearchType } from 'components/SearchPage/SearchToolbar'

interface Props extends WithTranslation {
  searchTypes: SearchType[]
  activeType: SearchType
  changeType: Function
}

interface State {
  open: boolean
}

class SearchTypeDropdown extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.toggle = this.toggle.bind(this)
    this.state = { open: false }
  }

  toggle() {
    const { open } = this.state
    this.setState({ open: !open })
  }

  render() {
    const { t, searchTypes, activeType, changeType } = this.props
    const { name: activeTypeName, icon: activeTypeIcon } = searchTypes.filter(e => e.key === activeType.key)[0]

    return (
      <Dropdown className="d-sm-none" isOpen={this.state.open} toggle={this.toggle}>
        <DropdownToggle className="ml-auto d-block" caret>
          {activeTypeIcon} {activeTypeName} ...
        </DropdownToggle>
        <DropdownMenu right>
          {searchTypes.map(({ key, icon, name }) => (
            <DropdownItem key={key} onClick={() => changeType(key)} active={key === activeType.key}>
              {icon} {name}
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
    )
  }
}

export default withTranslation()(SearchTypeDropdown)
