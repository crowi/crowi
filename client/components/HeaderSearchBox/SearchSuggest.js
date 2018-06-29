import React from 'react'
import PropTypes from 'prop-types'

import ListView from 'components/PageList/ListView'

export default class SearchSuggest extends React.Component {
  render() {
    if (!this.props.focused) {
      return <div />
    }

    if (this.props.searching) {
      return (
        <div className="search-suggest" id="search-suggest">
          <i className="searcing fa fa-circle-o-notch fa-spin fa-fw" /> Searching ...
        </div>
      )
    }

    if (this.props.searchError !== null) {
      return (
        <div className="search-suggest" id="search-suggest">
          <i className="searcing fa fa-exclamation-triangle" /> Error on searching.
        </div>
      )
    }

    if (this.props.searchedPages.length < 1) {
      if (this.props.searchingKeyword !== '') {
        return (
          <div className="search-suggest" id="search-suggest">
            No results for "{this.props.searchingKeyword}".
          </div>
        )
      }
      return <div />
    }

    return (
      <div className="search-suggest" id="search-suggest">
        <ListView pages={this.props.searchedPages} />
      </div>
    )
  }
}

SearchSuggest.propTypes = {
  searchedPages: PropTypes.array.isRequired,
  searchingKeyword: PropTypes.string.isRequired,
  searching: PropTypes.bool.isRequired,
}

SearchSuggest.defaultProps = {
  searchedPages: [],
  searchingKeyword: '',
  searchError: null,
  searching: false,
  focused: false,
}
