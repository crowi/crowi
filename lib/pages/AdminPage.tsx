import React, { FC } from 'react'
import Document from '../components/Document'
import Single, { Props as SingleProps } from '../components/Layout/Single'

type Props = SingleProps

const AdminPage: FC<Props> = props => {
  const { context } = props
  return (
    <Document title={`Wiki管理 · ${context.path}`} context={context}>
      <Single context={context}>
        <div className="header-wrap">
          <header id="page-header">
            <h1 className="title">Wiki管理</h1>
          </header>
        </div>
        <div id="admin-page" className="content-main content-form" data-csrftoken={context.csrfToken}></div>
      </Single>
    </Document>
  )
}

export default AdminPage
