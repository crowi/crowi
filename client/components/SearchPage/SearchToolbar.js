// @flow
import React from 'react'
import { translate } from 'react-i18next'
import { Nav, NavItem, NavLink } from 'reactstrap'
import Icon from 'components/Common/Icon'

type Props = {
  keyword?: string,
  type?: string,
  total?: number,
  changeType?: Function,
  searching?: boolean,
  t: Function,
}

class SearchToolbar extends React.Component<Props> {
  static defaultProps = {
    keyword: '',
    type: '',
    searching: false,
    total: 0,
  }

  static searchTypes = ['', 'portal', 'public', 'user']

  getActiveType = () => {
    const defaultType = SearchToolbar.searchTypes[0]
    const { type } = this.props
    return SearchToolbar.searchTypes.includes(type) ? type : defaultType
  }

  onClick = type => {
    const { changeType } = this.props
    return () => changeType && changeType(type)
  }

  render() {
    const { searchTypes } = SearchToolbar
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
            <NavItem active={actionType === searchTypes[0]} onClick={this.onClick(searchTypes[0])}>
              <NavLink>
                <Icon name="th" />
                {t('page_types.all')}
              </NavLink>
            </NavItem>
            <NavItem active={actionType === searchTypes[1]} onClick={this.onClick(searchTypes[1])}>
              <NavLink>
                <Icon name="circle" regular />
                {t('page_types.portal')}
              </NavLink>
            </NavItem>
            <NavItem active={actionType === searchTypes[2]} onClick={this.onClick(searchTypes[2])}>
              <NavLink>
                <Icon name="file" regular />
                {t('page_types.public')}
              </NavLink>
            </NavItem>
            <NavItem active={actionType === searchTypes[3]} onClick={this.onClick(searchTypes[3])}>
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

export default translate()(SearchToolbar)
