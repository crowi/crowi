import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Nav, NavItem } from 'react-bootstrap'
import Icon from 'components/Common/Icon'

class SearchToolbar extends React.Component {
  constructor() {
    super()

    this.searchTypes = ['', 'portal', 'public', 'user']

    this.getActiveType = this.getActiveType.bind(this)
  }

  getActiveType() {
    const defaultType = this.searchTypes[0]
    const { type } = this.props
    return this.searchTypes.includes(type) ? type : defaultType
  }

  render() {
    const { t } = this.props
    return (
      <div className="search-toolbar row">
        <div className="search-meta col-xs-4">
          <h3 className="search-keyword">{this.props.keyword}</h3>
          <small className="text-muted">{t('search.toolbar.results', { value: this.props.total })}</small>
        </div>
        <nav className="search-navbar col-xs-8">
          <Nav bsClass="nav navbar-nav" activeKey={this.getActiveType()} onSelect={this.props.changeType}>
            <NavItem eventKey={this.searchTypes[0]} href="#">
              <Icon name="th" />
              {t('page_types.all')}
            </NavItem>
            <NavItem eventKey={this.searchTypes[1]} href="#">
              <Icon name="circle" regular />
              {t('page_types.portal')}
            </NavItem>
            <NavItem eventKey={this.searchTypes[2]} href="#">
              <Icon name="file" regular />
              {t('page_types.public')}
            </NavItem>
            <NavItem eventKey={this.searchTypes[3]} href="#">
              <Icon name="user" regular />
              {t('page_types.user')}
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
  t: PropTypes.func.isRequired,
}
SearchToolbar.defaultProps = {
  keyword: '',
  type: '',
  total: 0,
}

export default translate()(SearchToolbar)
