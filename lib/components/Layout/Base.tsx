import React, { FC } from 'react'
import { AppContext } from 'server/types/appContext'
import Header from '../Header'
import { I18nextProvider } from 'react-i18next'

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

const Container = ({ show, children }) => (show ? <div className="v2-container">{children}</div> : children)

const Base: FC<Props> = ({ headerComponent, sidebarComponent, mainComponent, contentsFooterComponent, footerComponent, context }) => {
  return (
    <I18nextProvider i18n={context.i18n}>
      <Container show={!!headerComponent}>
        {headerComponent === undefined ? <Header {...context} /> : headerComponent}
        <div className="v2-contents-container">
          {sidebarComponent}
          {mainComponent}
          {contentsFooterComponent}
        </div>
      </Container>
      {footerComponent}
    </I18nextProvider>
  )
}

export default Base
