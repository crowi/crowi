import React from 'react'
import PropTypes from 'prop-types'

import PageBody from 'components/Page/PageBody.js'

export default class SearchResultList extends React.Component {
  render() {
    const resultList = this.props.pages.map(page => {
      const pageBody = page.revision.body
      return (
        <div id={page._id} key={page._id} className="search-result-page">
          <h2>
            <a href={page.path}>{page.path}</a>
          </h2>
          <div className="wiki">
            <PageBody
              className="hige"
              page={page}
              pageBody={pageBody}
              highlightKeywords={this.props.searchingKeyword}
            />
          </div>
        </div>
      )
    })

    return <div>{resultList}</div>
  }
}

SearchResultList.propTypes = {
  pages: PropTypes.array.isRequired,
  searchingKeyword: PropTypes.string.isRequired,
}

SearchResultList.defaultProps = {
  pages: [],
  searchingKeyword: '',
}
