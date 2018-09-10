import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import Icon from 'components/Common/Icon'
import SearchTypeTabs from './SearchTypeTabs'
import SearchLanguageDropdown from './SearchLanguageDropdown'

class SearchToolbar extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      query: {},
    }

    this.search = this.search.bind(this)
    this.changeType = this.changeType.bind(this)
    this.changeLanguage = this.changeLanguage.bind(this)
  }

  search(override) {
    const { search } = this.props
    const query = {
      ...this.state.query,
      ...override,
    }
    this.setState(query)
    if (search) {
      search(query)
    }
  }

  changeType(type) {
    this.search({ type })
  }

  changeLanguage(language) {
    this.search({ language })
  }

  render() {
    const { changeType, changeLanguage } = this
    const { crowi, t, type, language } = this.props
    return (
      <div className="search-toolbar row">
        <div className="search-meta col-4">
          <h3 className="search-keyword">{this.props.keyword}</h3>
          <small className="text-muted">
            {(this.props.searching && <Icon name="spinner" spin />) || t('search.toolbar.results', { value: this.props.total })}
          </small>
        </div>
        <SearchTypeTabs type={type} changeType={changeType} />
        <SearchLanguageDropdown crowi={crowi} language={language} changeLanguage={changeLanguage} />
      </div>
    )
  }
}

SearchToolbar.propTypes = {
  crowi: PropTypes.object.isRequired,
  keyword: PropTypes.string,
  language: PropTypes.string,
  type: PropTypes.string,
  total: PropTypes.number,
  search: PropTypes.func,
  searching: PropTypes.bool,
  t: PropTypes.func.isRequired,
}
SearchToolbar.defaultProps = {
  keyword: '',
  type: '',
  language: '',
  searching: false,
  total: 0,
}

export default translate()(SearchToolbar)
