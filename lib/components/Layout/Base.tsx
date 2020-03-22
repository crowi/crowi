import React, { FC } from 'react'
import Header from '../Header'

export interface Props {
  title?: string
  bodyProps?: React.HTMLAttributes<HTMLBodyElement>
  bodyClassNames?: string[]
  headerComponent?: React.ReactNode
  sidebarComponent?: React.ReactNode
  mainComponent?: React.ReactNode
  contentsFooterComponent?: React.ReactNode
  footerComponent?: React.ReactNode
}

const Container = ({ show, children }) => (show ? <div className="v2-container">{children}</div> : children)

const Base: FC<Props> = ({ headerComponent, sidebarComponent, mainComponent, contentsFooterComponent, footerComponent }) => {
  return (
    <>
      <Container show={!!headerComponent}>
        {headerComponent === undefined ? <Header /> : headerComponent}
        <div className="v2-contents-container">
          {sidebarComponent}
          {mainComponent}
          {contentsFooterComponent}
        </div>
      </Container>
      {footerComponent}
    </>
  )
}

export default Base
