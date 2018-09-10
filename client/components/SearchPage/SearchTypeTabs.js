import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Nav, NavItem, NavLink } from 'reactstrap'
import Icon from 'components/Common/Icon'

class SearchTypeTabs extends React.Component {
  constructor(props) {
    super(props)

    this.searchTypes = ['', 'portal', 'public', 'user']

    this.getActiveType = this.getActiveType.bind(this)
    this.onClick = this.onClick.bind(this)
  }

  getActiveType() {
    const defaultType = this.searchTypes[0]
    const { type } = this.props
    return this.searchTypes.includes(type) ? type : defaultType
  }

  onClick(type) {
    const { changeType } = this.props
    return () => changeType && changeType(type)
  }

  render() {
    const activeType = this.getActiveType()
    const { t } = this.props
    return (
      <nav className="search-type-tabs">
        <Nav className="nav navbar-nav">
          <NavItem active={activeType === this.searchTypes[0]} onClick={this.onClick(this.searchTypes[0])}>
            <NavLink>
              <Icon name="th" />
              {t('page_types.all')}
            </NavLink>
          </NavItem>
          <NavItem active={activeType === this.searchTypes[1]} onClick={this.onClick(this.searchTypes[1])}>
            <NavLink>
              <Icon name="circle" regular />
              {t('page_types.portal')}
            </NavLink>
          </NavItem>
          <NavItem active={activeType === this.searchTypes[2]} onClick={this.onClick(this.searchTypes[2])}>
            <NavLink>
              <Icon name="file" regular />
              {t('page_types.public')}
            </NavLink>
          </NavItem>
          <NavItem active={activeType === this.searchTypes[3]} onClick={this.onClick(this.searchTypes[3])}>
            <NavLink>
              <Icon name="user" regular />
              {t('page_types.user')}
            </NavLink>
          </NavItem>
        </Nav>
      </nav>
    )
  }
}

SearchTypeTabs.propTypes = {
  type: PropTypes.string.isRequired,
  changeType: PropTypes.func.isRequired,
  t: PropTypes.func.isRequired,
}
SearchTypeTabs.defaultProps = {
  keyword: '',
  type: '',
}

export default translate()(SearchTypeTabs)
