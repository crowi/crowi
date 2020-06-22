import React, { FC } from 'react'
import classNames from 'classnames'
import { assetPath } from 'server/util/ssr'
import { AppContext } from 'server/types/appContext'

export interface Props {
  title?: string
  bodyProps?: React.HTMLAttributes<HTMLBodyElement>
  bodyClassNames?: string[]
  headerComponent?: React.ReactNode
  sidebarComponent?: React.ReactNode
  mainComponent?: React.ReactNode
  contentsFooterComponent?: React.ReactNode
  footerComponent?: React.ReactNode
  context: AppContext
}

const Document: FC<Props> = ({ title, bodyProps, bodyClassNames = [], context, children }) => {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge,chrome=1" />
        <title>{title || context.title}</title>
        <meta name="description" content="" />
        <meta name="author" content="" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="apple-mobile-web-app-title" content={title || context.title} />
        <link rel="shortcut icon" href="/favicon.ico" type="image/x-icon" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="apple-touch-icon" sizes="72x72" href="/apple-touch-icon-72x72.png" />
        <link rel="apple-touch-icon" sizes="120x120" href="/apple-touch-icon-120x120.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180x180.png" />
        <link rel="icon" type="image/png" href="/favicon-32x32.png" sizes="32x32" />
        <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />
        <link rel="icon" type="image/png" href="/android-chrome-192x192.png" sizes="192x192" />
        <link rel="stylesheet" href="/css/crowi.css" />
        <script src={assetPath('/js/runtime.js')}></script>
        <script src={assetPath('/js/bundled.js')}></script>
        <link href="//fonts.googleapis.com/css?family=Open+Sans:400,600,700" rel="stylesheet" type="text/css" />
      </head>
      <body className={classNames('crowi', 'main-container', ...bodyClassNames)} id="crowi-main-container" {...bodyProps}>
        <div id="root">{children}</div>
      </body>
      <script dangerouslySetInnerHTML={{ __html: `window.APP_CONTEXT = ${JSON.stringify(context)}` }} />
      <script src={assetPath('/js/app.js')}></script>
      <script src={assetPath('/js/crowi.js')}></script>
    </html>
  )
}

export default Document
