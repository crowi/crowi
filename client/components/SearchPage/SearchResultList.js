// @flow
import React from 'react';

import PageBody from 'components/Page/PageBody.js'

type Props = {
  pages: Array<any>,
  searchingKeyword: string,
};

export default class SearchResultList extends React.Component {
  props: Props;
  render() {
    const resultList = this.props.pages.map(page => {
      const pageBody = page.revision.body
      return (
        <div id={page._id} key={page._id} className="search-result-page">
          <h2>
            <a href={page.path}>{page.path}</a>
          </h2>
          <div className="wiki">
            <PageBody className="hige" page={page} pageBody={pageBody} highlightKeywords={this.props.searchingKeyword} />
          </div>
        </div>
      )
    })

    return <div>{resultList}</div>
  }
}

SearchResultList.defaultProps = {
  pages: [],
  searchingKeyword: '',
}
