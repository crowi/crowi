import React, { FC } from 'react'
import { format } from 'date-fns'

import Document from 'server/components/Document'
import Single from 'server/components/Layout/Single'
import { PageProps } from 'server/types/pageProps'
import { Page as PageType } from 'client/types/crowi'
import App from 'server/components/App'

type Props = {
  hasSecretKeyword: boolean
  shareId: string
  page: PageType | null
} & PageProps

const SharePage: FC<Props> = (props) => {
  const { i18n, context, hasSecretKeyword, shareId, page } = props

  return (
    <Document title={((page && `${page.path} · `) || '') + `${context.title}`} context={context}>
      <App i18n={i18n} context={context}>
        <Single headerComponent={null} footerComponent={null}>
          {(hasSecretKeyword && page !== null && (
            <div className="share-page">
              <div
                id="content-main"
                className="content-main"
                data-page-id={page._id}
                data-page-revision-id={page.revision._id}
                data-page-revision-created={page.revision.createdAt}
                data-is-share-page={1}
              >
                <div className="tab-content wiki-content">
                  <script type="text/template" id="raw-text-original">
                    {page.revision.body}
                  </script>

                  <div className="tab-pane active" id="revision-body">
                    <div className="revision-toc" id="revision-toc">
                      <a data-toggle="collapse" data-parent="#revision-toc" href="#revision-toc-content" className="revision-toc-head collapsed">
                        {i18n.t('Table of Contents')}
                      </a>
                    </div>
                    <div className="wiki" id="revision-body-content"></div>
                  </div>
                </div>
              </div>
              <div id="page-alerts"></div>
              <p className="page-meta meta">
                Last updated at {format(page.updatedAt, 'yyyy-MM-dd HH:mm:ss')}
                <br />
                Created at {format(page.createdAt, 'yyyy-MM-dd HH:mm:ss')}
                <br />
              </p>
            </div>
          )) || <div id="secret-keyword-form-container" data-share-id={shareId}></div>}
        </Single>
      </App>
    </Document>
  )
}

export default SharePage
