import React, { FC, useContext } from 'react'
import Base, { Props as BaseProps } from './Base'
import { useTranslation } from 'react-i18next'
import Icon from 'client/components/Common/Icon'
import { AppContext } from '../App'

export type Props = {
  footerComponent?: React.ReactNode
} & BaseProps

const Single: FC<Props> = ({ children, footerComponent, ...baseProps }) => {
  const [t] = useTranslation()
  const { title } = useContext(AppContext)

  return (
    <Base
      mainComponent={
        <div id="main" className="main layout-single">
          <article>{children}</article>
        </div>
      }
      footerComponent={
        (footerComponent && footerComponent) || (
          <div id="footer-container" className="footer">
            <footer>
              <p>
                <a href="" data-target="#help-modal" data-toggle="modal">
                  <Icon name="helpCircle" /> {t('Help')}
                </a>{' '}
                &copy; {new Date().getFullYear()} {title} <img src="/logo/powered-by-crowi.png" width="100" alt="powered by Crowi" />
              </p>
            </footer>
          </div>
        )
      }
      {...baseProps}
    ></Base>
  )
}

export default Single
