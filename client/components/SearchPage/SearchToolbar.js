import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Nav, NavItem, NavLink } from 'reactstrap'
import Icon from 'components/Common/Icon'

class SearchToolbar extends React.Component {
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
    const actionType = this.getActiveType()
    const { t } = this.props
    return (
      <div className="search-toolbar row">
        <div className="search-meta col-4">
          <h3 className="search-keyword">{this.props.keyword}</h3>
          <small className="text-muted">
            {(this.props.searching && <Icon name="spinner" spin />) || t('search.toolbar.results', { value: this.props.total })}
          </small>
        </div>
        <nav className="search-navbar col-8">
          <Nav className="nav navbar-nav">
            <NavItem active={actionType === this.searchTypes[0]} onClick={this.onClick(this.searchTypes[0])}>
              <NavLink>
                <Icon name="th" />
                {t('page_types.all')}
              </NavLink>
            </NavItem>
            <NavItem active={actionType === this.searchTypes[1]} onClick={this.onClick(this.searchTypes[1])}>
              <NavLink>
                <Icon name="circle" regular />
                {t('page_types.portal')}
              </NavLink>
            </NavItem>
            <NavItem active={actionType === this.searchTypes[2]} onClick={this.onClick(this.searchTypes[2])}>
              <NavLink>
                <Icon name="file" regular />
                {t('page_types.public')}
              </NavLink>
            </NavItem>
            <NavItem active={actionType === this.searchTypes[3]} onClick={this.onClick(this.searchTypes[3])}>
              <NavLink>
                <Icon name="user" regular />
                {t('page_types.user')}
              </NavLink>
            </NavItem>
          </Nav>
        </nav>
      </div>
    )
  }
}

SearchToolbar.propTypes = {
  keyword: PropTypes.string,
  type: PropTypes.string,
  total: PropTypes.number,
  changeType: PropTypes.func,
  searching: PropTypes.bool,
  t: PropTypes.func.isRequired,
}
SearchToolbar.defaultProps = {
  keyword: '',
  type: '',
  searching: false,
  total: 0,
}

export default translate()(SearchToolbar)
