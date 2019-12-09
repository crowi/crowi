import React, { FC } from 'react'
import Document from '../components/Document'
import Single from '../components/Layout/Single'
import { PageProps } from 'server/types/pageProps'
import App from 'server/components/App'

const AdminPage: FC<PageProps> = props => {
  const { i18n, context } = props

  return (
    <Document title={`Wiki管理 · ${context.path}`} context={context}>
      <App i18n={i18n} context={context}>
        <Single>
          <div className="header-wrap">
            <header id="page-header">
              <h1 className="title">Wiki管理</h1>
            </header>
          </div>
          <div id="admin-page" className="content-main content-form" data-csrftoken={context.csrfToken}></div>
        </Single>
      </App>
    </Document>
  )
}

export default AdminPage
