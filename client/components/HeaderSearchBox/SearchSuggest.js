import React from 'react'
import PropTypes from 'prop-types'

import { Card } from 'reactstrap'
import ListView from 'components/PageList/ListView'

export default class SearchSuggest extends React.Component {
  renderBody() {
    const { searching, searchError, searchedPages, searchingKeyword } = this.props
    if (searching) {
      return (
        <div>
          <i className="searcing fa fa-circle-o-notch fa-spin fa-fw" /> Searching ...
        </div>
      )
    }
    if (searchError !== null) {
      return (
        <div>
          <i className="searcing fa fa-exclamation-triangle" /> Error on searching.
        </div>
      )
    }
    if (searchedPages.length < 1 && searchingKeyword !== '') {
      return <div>No results for &quot;{searchingKeyword}&quot;.</div>
    }
    return <ListView pages={searchedPages} />
  }

  render() {
    const { focused, searchedPages, searchingKeyword } = this.props
    const searched = searchedPages.length >= 1 || searchingKeyword !== ''
    if (!focused || !searched) {
      return <div />
    }
    return (
      <Card body className="search-suggest" id="search-suggest">
        {this.renderBody()}
      </Card>
    )
  }
}

SearchSuggest.propTypes = {
  searchedPages: PropTypes.array.isRequired,
  searchingKeyword: PropTypes.string.isRequired,
  searching: PropTypes.bool.isRequired,
  searchError: PropTypes.object,
  focused: PropTypes.bool,
}

SearchSuggest.defaultProps = {
  searchedPages: [],
  searchingKeyword: '',
  searchError: null,
  searching: false,
  focused: false,
}
