import React, { FC } from 'react'
import Document from 'server/components/Document'
import Single from 'server/components/Layout/Single'
import { PageProps } from 'server/types/pageProps'
import App from 'server/components/App'

const SearchPage: FC<PageProps> = props => {
  const { i18n, context } = props

  return (
    <Document title={`Search · ${context.title}`} context={context}>
      <App i18n={i18n} context={context}>
        <Single>
          <div id="search-page"></div>
        </Single>
      </App>
    </Document>
  )
}

export default SearchPage
