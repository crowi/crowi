import React from 'react'
import PageBody from 'components/Page/PageBody'
import { Page } from 'client/types/crowi'

interface Props {
  pages: Page[]
  searchingKeyword: string
}

export default class SearchResultList extends React.Component<Props> {
  static defaultProps = { pages: [], searchingKeyword: '' }

  render() {
    const resultList = this.props.pages.map((page) => {
      const pageBody = page.revision.body
      return (
        <div id={page._id} key={page._id} className="search-result-page">
          <h2>
            <a href={page.path}>{page.path}</a>
          </h2>
          <div className="wiki">
            <PageBody page={page} pageBody={pageBody} highlightKeywords={this.props.searchingKeyword} />
          </div>
        </div>
      )
    })

    return <div>{resultList}</div>
  }
}
