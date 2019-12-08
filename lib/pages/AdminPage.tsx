import React, { FC } from 'react'
import Single, { Props as SingleProps } from '../components/Layout/Single'

type Props = SingleProps

const AdminPage: FC<Props> = props => {
  const { context } = props
  return (
    <Single title={`Wiki管理 · ${context.path}`} context={context}>
      <div className="header-wrap">
        <header id="page-header">
          <h1 className="title">Wiki管理</h1>
        </header>
      </div>
      <div id="admin-page" className="content-main content-form" data-csrftoken={context.csrfToken}></div>
    </Single>
  )
}

export default AdminPage
